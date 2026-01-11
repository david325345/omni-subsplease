const { serveHTTP, manifestBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const xml2js = require('xml2js');

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD";
const CACHE_MAX_AGE = 4 * 60 * 60; // 4 hodiny cache
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';

// Pomocná funkce pro získání API klíče z nastavení Stremia
const getRdKey = (args) => {
    // Stremio posílá konfiguraci v query parametrech nebo v těle requestu
    if (args.config && args.config.rd_token) return args.config.rd_token;
    if (args.extra && args.extra.config && args.extra.config.rd_token) return args.extra.config.rd_token;
    return null;
};

// --- REAL-DEBRID API LOGIKA ---
async function getRdStreamLink(magnetLink, rdToken) {
    try {
        // 1. Přidání magnetu do RD
        const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        
        const torrentId = addRes.data.id;
        
        // 2. Získání informací o torrentu (aby jsme vybrali soubor)
        // V reálném nasazení by se mělo čekat na stav 'downloaded', ale pro demo zkusíme select hned nebo počkáme chvíli
        const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );

        // Vybereme největší video soubor (obvykle to je ten pravý epizodní soubor)
        // Pokud jsou tam soubory, vybereme ID největšího
        let files = infoRes.data.files || [];
        let fileId = "all"; // Default
        
        if (files.length > 0) {
            // Filtrujeme pouze video soubory a seřadíme podle velikosti
            const videoFiles = files.filter(f => f.path.match(/\.(mp4|mkv|avi)$/i));
            if (videoFiles.length > 0) {
                // Seřadíme sestupně a vezmeme největší
                videoFiles.sort((a, b) => b.bytes - a.bytes);
                fileId = videoFiles[0].id;
            }
        }

        // 3. Vybrání souborů k přehrání
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
            `files=${fileId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );

        // 4. Získání streamovacího linku
        // Poznámka: V produkci by zde měla být smyčka, která čeká, dokud není stav 'downloaded'
        // Zde zjednodušíme a vrátíme link (pokud to RD ještě nestáhl, vrátí to chybu, ale ukáže proces)
        const linksRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        
        if (linksRes.data.links && linksRes.data.links.length > 0) {
            return linksRes.data.links[0]; // Vrátí první dostupný link (http)
        } else {
            throw new Error("Link ještě není připraven (Real-Debrid stahuje).");
        }

    } catch (error) {
        console.error("RD API Error:", error.response?.data || error.message);
        throw error;
    }
}

// --- CATALOG HANDLER (Načítání RSS) ---
const catalogHandler = async ({ config }) => {
    try {
        // Stáhneme RSS
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);

        const items = result.rss?.channel?.[0]?.item || [];
        
        const metas = items.map(item => {
            const title = item.title?.[0] || "Unknown Title";
            const link = item.link?.[0] || ""; // Odkaz na stránku
            const pubDate = item.pubDate?.[0] || "";
            
            // Získání magnetu z description (SubsPlease ho dává do <a>)
            const descHtml = item.description?.[0] || "";
            const match = descHtml.match(/href="([^"]+)"/);
            const magnetLink = match ? match[1] : null;

            // Generování ID - použijeme název, protože nemáme IMDB ID
            const id = `subsplease:${Buffer.from(title).toString('base64').substring(0, 20)}`;

            return {
                id: id,
                type: 'movie', // V Stremiu označíme epizody jako 'movie' pro jednoduchost, nebo jako 'series' pokud chceme složitější strukturu
                name: title,
                poster: `https://picsum.photos/seed/${encodeURIComponent(title)}/200/300`,
                description: `Vydáno: ${new Date(pubDate).toLocaleString()}\nLink: ${link}`,
                // Uložíme magnet link do custom vlastnosti, abychom ho použili ve stream handleru
                subsplease_magnet: magnetLink 
            };
        });

        return { metas };

    } catch (error) {
        console.error("Chyba načítání RSS:", error.message);
        return { metas: [] };
    }
};

// --- STREAM HANDLER ---
const streamHandler = async (args) => {
    const rdToken = getRdKey(args);
    
    if (!rdToken) {
        // Pokud nemá token, vrátíme chybovou zprávu, která se zobrazí v UI
        throw new Error("Není nastaven Real-Debrid API klíč. Otevřete nastavení addonu.");
    }

    // V katalogu jsme uložili magnet do property 'subsplease_magnet'
    // Bohužel standardní Meta objekt se nepřenáší do stream handleru kompletně, 
    // takže musíme buď znovu parsovat RSS nebo využít ID k mapování.
    // Pro jednoduchost v tomto demu předpokládáme, že ID obsahuje base64 názvu,
    // ale lepší je ukládat data do cache.
    
    // ZDE JE PROBLÉM: Stream handler nedostane 'meta' objekt zpátky.
    // Musíme si magnet pamatovat. V tomto demu pro zjednodušení uděláme malý trik:
    // V ID zakódujeme samotný magnet (je to dlouhé, ale funguje to pro demo).
    // NEBO: Jednodušeše projdeme RSS znovu a najdeme shodu podle názvu v ID.
    
    // Zkusíme najít znovu v RSS
    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        // Najdeme item, který odpovídá ID (dekódujeme název z ID)
        // ID má formát: subsplease:BASE64_TITLE
        const base64Title = args.id.replace('subsplease:', '');
        const decodedTitle = Buffer.from(base64Title, 'base64').toString('utf-8');
        
        const item = items.find(i => (i.title?.[0] || "").startsWith(decodedTitle.substring(0, 15)));
        
        if (!item || !item.description?.[0]) throw new Error("Epizoda nenalezena v RSS.");
        
        const descHtml = item.description[0];
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;

        if (!magnetLink) throw new Error("Magnet link nenalezen.");

        console.log(`Resolving stream for: ${decodedTitle} via Real-Debrid`);
        
        // Voláme RD
        const rdLink = await getRdStreamLink(magnetLink, rdToken);

        return {
            streams: [
                {
                    title: `Real-Debrid 1080p`,
                    url: rdLink
                }
            ]
        };

    } catch (error) {
        console.error(error);
        throw error;
    }
};

// --- MANIFEST DEFINICE ---
const manifest = manifestBuilder({
    id: 'community.subsplease.rd',
    version: '1.0.0',
    name: ADDON_NAME,
    description: 'Streamujte nové anime epizody z SubsPlease přes Real-Debrid.',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['movie', 'series'], // Používáme movie pro epizody pro jednoduchost
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [
        {
            type: 'movie',
            id: 'subsplease-feed',
            name: 'Nejnovější epizody',
            extra: [{ name: 'search', isRequired: false }]
        }
    ],
    // Donutí Stremio zobrazit nastavení
    behaviorHints: {
        configurationRequired: true 
    }
});

// --- CONFIG HANDLER (Pro UI nastavení klíče) ---
const configHandler = () => {
    return [
        {
            key: 'rd_token',
            type: 'text',
            title: 'Real-Debrid API Token',
            description: 'Vložte svůj token z https://real-debrid.com/apitoken'
        }
    ];
}

// --- BUILD INTERFACE ---
const addonInterface = {
    manifest: manifest,
    catalog: catalogHandler,
    stream: streamHandler,
    config: configHandler
};

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
serveHTTP(addonInterface, { port: PORT, cache: CACHE_MAX_AGE })
    .then(({ url }) => {
        console.log(`Addon běží na: ${url}`);
        console.log(`Pro instalaci ve Stremiu použijte URL: ${url}/manifest.json`);
    });const { serveHTTP, manifestBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const xml2js = require('xml2js');

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD";
const CACHE_MAX_AGE = 4 * 60 * 60; // 4 hodiny cache
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';

// Pomocná funkce pro získání API klíče z nastavení Stremia
const getRdKey = (args) => {
    // Stremio posílá konfiguraci v query parametrech nebo v těle requestu
    if (args.config && args.config.rd_token) return args.config.rd_token;
    if (args.extra && args.extra.config && args.extra.config.rd_token) return args.extra.config.rd_token;
    return null;
};

// --- REAL-DEBRID API LOGIKA ---
async function getRdStreamLink(magnetLink, rdToken) {
    try {
        // 1. Přidání magnetu do RD
        const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        
        const torrentId = addRes.data.id;
        
        // 2. Získání informací o torrentu (aby jsme vybrali soubor)
        // V reálném nasazení by se mělo čekat na stav 'downloaded', ale pro demo zkusíme select hned nebo počkáme chvíli
        const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );

        // Vybereme největší video soubor (obvykle to je ten pravý epizodní soubor)
        // Pokud jsou tam soubory, vybereme ID největšího
        let files = infoRes.data.files || [];
        let fileId = "all"; // Default
        
        if (files.length > 0) {
            // Filtrujeme pouze video soubory a seřadíme podle velikosti
            const videoFiles = files.filter(f => f.path.match(/\.(mp4|mkv|avi)$/i));
            if (videoFiles.length > 0) {
                // Seřadíme sestupně a vezmeme největší
                videoFiles.sort((a, b) => b.bytes - a.bytes);
                fileId = videoFiles[0].id;
            }
        }

        // 3. Vybrání souborů k přehrání
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
            `files=${fileId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );

        // 4. Získání streamovacího linku
        // Poznámka: V produkci by zde měla být smyčka, která čeká, dokud není stav 'downloaded'
        // Zde zjednodušíme a vrátíme link (pokud to RD ještě nestáhl, vrátí to chybu, ale ukáže proces)
        const linksRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        
        if (linksRes.data.links && linksRes.data.links.length > 0) {
            return linksRes.data.links[0]; // Vrátí první dostupný link (http)
        } else {
            throw new Error("Link ještě není připraven (Real-Debrid stahuje).");
        }

    } catch (error) {
        console.error("RD API Error:", error.response?.data || error.message);
        throw error;
    }
}

// --- CATALOG HANDLER (Načítání RSS) ---
const catalogHandler = async ({ config }) => {
    try {
        // Stáhneme RSS
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);

        const items = result.rss?.channel?.[0]?.item || [];
        
        const metas = items.map(item => {
            const title = item.title?.[0] || "Unknown Title";
            const link = item.link?.[0] || ""; // Odkaz na stránku
            const pubDate = item.pubDate?.[0] || "";
            
            // Získání magnetu z description (SubsPlease ho dává do <a>)
            const descHtml = item.description?.[0] || "";
            const match = descHtml.match(/href="([^"]+)"/);
            const magnetLink = match ? match[1] : null;

            // Generování ID - použijeme název, protože nemáme IMDB ID
            const id = `subsplease:${Buffer.from(title).toString('base64').substring(0, 20)}`;

            return {
                id: id,
                type: 'movie', // V Stremiu označíme epizody jako 'movie' pro jednoduchost, nebo jako 'series' pokud chceme složitější strukturu
                name: title,
                poster: `https://picsum.photos/seed/${encodeURIComponent(title)}/200/300`,
                description: `Vydáno: ${new Date(pubDate).toLocaleString()}\nLink: ${link}`,
                // Uložíme magnet link do custom vlastnosti, abychom ho použili ve stream handleru
                subsplease_magnet: magnetLink 
            };
        });

        return { metas };

    } catch (error) {
        console.error("Chyba načítání RSS:", error.message);
        return { metas: [] };
    }
};

// --- STREAM HANDLER ---
const streamHandler = async (args) => {
    const rdToken = getRdKey(args);
    
    if (!rdToken) {
        // Pokud nemá token, vrátíme chybovou zprávu, která se zobrazí v UI
        throw new Error("Není nastaven Real-Debrid API klíč. Otevřete nastavení addonu.");
    }

    // V katalogu jsme uložili magnet do property 'subsplease_magnet'
    // Bohužel standardní Meta objekt se nepřenáší do stream handleru kompletně, 
    // takže musíme buď znovu parsovat RSS nebo využít ID k mapování.
    // Pro jednoduchost v tomto demu předpokládáme, že ID obsahuje base64 názvu,
    // ale lepší je ukládat data do cache.
    
    // ZDE JE PROBLÉM: Stream handler nedostane 'meta' objekt zpátky.
    // Musíme si magnet pamatovat. V tomto demu pro zjednodušení uděláme malý trik:
    // V ID zakódujeme samotný magnet (je to dlouhé, ale funguje to pro demo).
    // NEBO: Jednodušeše projdeme RSS znovu a najdeme shodu podle názvu v ID.
    
    // Zkusíme najít znovu v RSS
    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        // Najdeme item, který odpovídá ID (dekódujeme název z ID)
        // ID má formát: subsplease:BASE64_TITLE
        const base64Title = args.id.replace('subsplease:', '');
        const decodedTitle = Buffer.from(base64Title, 'base64').toString('utf-8');
        
        const item = items.find(i => (i.title?.[0] || "").startsWith(decodedTitle.substring(0, 15)));
        
        if (!item || !item.description?.[0]) throw new Error("Epizoda nenalezena v RSS.");
        
        const descHtml = item.description[0];
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;

        if (!magnetLink) throw new Error("Magnet link nenalezen.");

        console.log(`Resolving stream for: ${decodedTitle} via Real-Debrid`);
        
        // Voláme RD
        const rdLink = await getRdStreamLink(magnetLink, rdToken);

        return {
            streams: [
                {
                    title: `Real-Debrid 1080p`,
                    url: rdLink
                }
            ]
        };

    } catch (error) {
        console.error(error);
        throw error;
    }
};

// --- MANIFEST DEFINICE ---
const manifest = manifestBuilder({
    id: 'community.subsplease.rd',
    version: '1.0.0',
    name: ADDON_NAME,
    description: 'Streamujte nové anime epizody z SubsPlease přes Real-Debrid.',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['movie', 'series'], // Používáme movie pro epizody pro jednoduchost
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [
        {
            type: 'movie',
            id: 'subsplease-feed',
            name: 'Nejnovější epizody',
            extra: [{ name: 'search', isRequired: false }]
        }
    ],
    // Donutí Stremio zobrazit nastavení
    behaviorHints: {
        configurationRequired: true 
    }
});

// --- CONFIG HANDLER (Pro UI nastavení klíče) ---
const configHandler = () => {
    return [
        {
            key: 'rd_token',
            type: 'text',
            title: 'Real-Debrid API Token',
            description: 'Vložte svůj token z https://real-debrid.com/apitoken'
        }
    ];
}

// --- BUILD INTERFACE ---
const addonInterface = {
    manifest: manifest,
    catalog: catalogHandler,
    stream: streamHandler,
    config: configHandler
};

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
serveHTTP(addonInterface, { port: PORT, cache: CACHE_MAX_AGE })
    .then(({ url }) => {
        console.log(`Addon běží na: ${url}`);
        console.log(`Pro instalaci ve Stremiu použijte URL: ${url}/manifest.json`);
    });