console.log(">>> SPAUŠTĚNÍ WEB UI V36 (STEMIO READY) <<<");

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

// AXIOS DEFAULTS - Zabrání zamotání
axios.defaults.timeout = 10000; // 10s timeout pro všechny externí dotazy

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v36";
const CACHE_MAX_AGE = 4 * 60 * 60; 
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';
const ANILIST_API = 'https://graphql.anilist.co';

// CACHE & PROMĚNNÉ
let rssItems = [];
let metadataCache = new Map(); 
let streamCache = new Map(); 
let lastRssUpdate = 0;

// --- MANIFEST OBJEKT ---
const manifestObj = {
    id: 'community.subsplease.rd.v36',
    version: '26.0.0',
    name: ADDON_NAME,
    description: 'SubsPlease Addon - 20s Timeout',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['movie'],
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [{ type: 'movie', id: 'subsplease-feed', name: 'Nejnovější epizody' }],
    behaviorHints: { configurationRequired: false }
};

// --- MIDDLEWARE ---
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.writeHead(204).end();
    }
    next();
});

// --- POMOCNÉ FUNKCE ---

const getReqConfig = (req) => {
    if (req.query.token) return { rd_token: req.query.token };
    if (req.query.config) try { return JSON.parse(req.query.config); } catch (e) {}
    if (req.query.extra) try { return JSON.parse(req.query.extra); } catch (e) {}
    return {};
};

const getRdKey = (req) => {
    const config = getReqConfig(req);
    return config.rd_token || null;
};

// EXTRAKCE MAGNETU (V33 FIXED)
function extractMagnet(item) {
    if (!item) return null;

    // Priority 1: <link>
    if (item.link) {
        const linkVal = Array.isArray(item.link) ? item.link[0] : item.link;
        if (linkVal && linkVal.startsWith('magnet:')) return linkVal;
        if (linkVal.$ && linkVal.$.url && linkVal.$.url.startsWith('magnet:')) return linkVal.$.url;
    }

    // Priority 2: <enclosure>
    if (item.enclosure) {
        let enc = item.enclosure;
        if (Array.isArray(enc)) enc = enc[0];
        const url = enc.$ ? enc.$.url : enc.url;
        if (url && url.startsWith('magnet:')) return url;
    }

    // Priority 3: <description>
    let desc = item.description;
    if (Array.isArray(desc)) desc = desc[0];
    if (typeof desc !== 'string') desc = "";
    
    const match = desc.match(/href=(["'])(.*?)\1/);
    if (match && match[2] && match[2].startsWith('magnet:')) return match[2];

    const directMagnet = desc.match(/(magnet:[^\s<]+)/);
    if (directMagnet) return directMagnet[1];

    return null;
}

// Aktualizace RSS
async function updateRssCache() {
    const now = Date.now();
    if (now - lastRssUpdate < 10 * 1000) return;
    
    try {
        console.log("Aktualizuji RSS...");
        // Používáme stejný timeout, aby se to nezaseklo
        const response = await axios.get(SUBSPLEASE_RSS, { timeout: 10000 }); 
        const parser = new xml2js.Parser({ trim: true, explicitArray: false, mergeAttrs: true });
        const result = await parser.parseStringPromise(response.data);
        
        const channelData = result.rss?.channel;
        const channel = Array.isArray(channelData) ? channelData[0] : channelData;
        
        rssItems = channel?.item || [];
        lastRssUpdate = now;
        
        console.log(`RSS Cache aktualizována. Načteno ${rssItems.length} položek.`);
    } catch (error) {
        console.error("Chyba aktualizace RSS Cache:", error.message);
        // Pokud se nepodaří načíst RSS, zůstaneme u starých dat
    }
}

function extractSeriesName(fullTitle) {
    let clean = fullTitle.replace(/\[.*?\]/g, '').trim();
    const parts = clean.split(/\s+-\s+/);
    return parts[0].trim();
}

function extractHash(fullTitle) {
    const match = fullTitle.match(/\[([A-F0-9]{8})\]/);
    return match ? match[1] : null;
}

// --- ANILIST INTEGRACE ---
async function getAniListMeta(fullTitle) {
    const seriesName = extractSeriesName(fullTitle);
    if (metadataCache.has(seriesName)) return metadataCache.get(seriesName);

    const query = `
        query ($search: String) {
          Media(search: $search, type: ANIME) {
            id
            title { romaji english native }
            description
            coverImage { extraLarge large }
            bannerImage
            genres
          }
        }
    `;

    try {
        const response = await axios.post(ANILIST_API, {
            query,
            variables: { search: seriesName }
        }, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            timeout: 10000 // 10s timeout
        });
        const media = response.data?.data?.Media;
        if (media) {
            console.log(`AniList nalezeno: ${seriesName}`);
            metadataCache.set(seriesName, media);
            return media;
        }
        return null;
    } catch (error) {
        console.error(`AniList Error pro ${seriesName}:`, error.message);
        return null;
    }
}

// --- REAL-DEBRID API (NO POLLING - FAST FAIL) ---
async function getRdStreamLink(magnetLink, rdToken) {
    try {
        // 1. ADD MAGNET
        console.log("RD: Přidávám magnet...");
        const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 15000 } // 15s timeout
        );
        const torrentId = addRes.data.id;
        
        // 2. INFO (JEDNÝ DOTAZ - NO POLLING)
        // Stremio toleruje chvíli čekání (např 5-10s), ale ne zaseknutí.
        // Pokud RD nestíhá do 20s, vyhodíme chybu "RD je zaneprázdný".
        console.log("RD: Získávám info...");
        const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 25000 } // 25s timeout
        );
        
        const status = infoRes.data.status;
        const files = infoRes.data.files || [];

        // CHYBOVÉ STAVY
        if (status === 'magnet_error') throw new Error('RD: Torrent je neplatný nebo byl smazán.');
        if (status === 'error') throw new Error('RD: Interní chyba serveru.');
        if (status === 'waiting_files_selection' && files.length === 0) {
             // Čekáme na soubory, ale nejsou tam.
             throw new Error('RD: Soubory se připravují. Zkuste znovu za 20 sekund.');
        }
        if (status === 'downloading') {
            throw new Error('RD: Epizoda se stahuje (nedokončeno). Zkuste znovu za chvíli.');
        }

        // 3. FILE SELECTION (Jen jednou)
        let fileId = "all";
        if (files.length > 0) {
            const videoFiles = files.filter(f => f.path.match(/\.(mp4|mkv|avi)$/i));
            if (videoFiles.length > 0) {
                videoFiles.sort((a, b) => b.bytes - a.bytes);
                fileId = videoFiles[0].id;
            }
        }
        
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
            `files=${fileId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 10000 }
        );
        
        // 4. LINKS (JEDNÝ DOTAZ)
        console.log("RD: Získávám linky...");
        const linksRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 25000 }
        );

        if (linksRes.data.links && linksRes.data.links.length > 0) {
            return linksRes.data.links[0];
        } else {
            // Pokud je status 'processing' nebo 'queued', ale linků není, hodíme chybu
            // Nebudeme čekat 2 minuty (v35), protože to rozbije Stremio UX.
            throw new Error("RD: Server je vytížený. Zkuste znovu za 1-2 minuty.");
        }
    } catch (error) {
        console.error("RD Error:", error.message);
        throw error;
    }
}

// --- HANDLERS ---

const catalogHandler = async (config) => {
    while (rssItems.length === 0) {
        await new Promise(r => setTimeout(r, 500));
    }

    const metas = rssItems.map(item => {
        const title = Array.isArray(item.title) ? item.title[0] : item.title;
        if (!title) return null;

        const pubDate = Array.isArray(item.pubDate) ? item.pubDate[0] : item.pubDate || "";
        const magnetLink = extractMagnet(item);
        
        const id = `subsplease:${Buffer.from(title).toString('base64')}`;
        const seriesName = extractSeriesName(title);
        const poster = `https://ui-avatars.com/api/?name=${encodeURIComponent(seriesName)}&background=6c5ce7&color=fff&size=300&font-size=0.3`;
        
        if (magnetLink) {
            streamCache.set(id, { magnet: magnetLink, title: title });
        }

        return {
            id: id,
            type: 'movie',
            name: title,
            poster: poster,
            background: `https://picsum.photos/seed/bg/${encodeURIComponent(seriesName)}/1200/600`,
            description: `Vydáno: ${new Date(pubDate).toLocaleString()}\nSeriál: ${seriesName}`,
            originalTitle: title
        };
    }).filter(m => m !== null);
    
    console.log(`Katalog vrácen: ${metas.length} položek.`);
    return { metas };
};

const metaHandler = async (id, extra) => {
    try {
        const originalTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
        const aniData = await getAniListMeta(originalTitle);
        const seriesName = extractSeriesName(originalTitle);
        
        const title = aniData?.title?.english || aniData?.title?.romaji || originalTitle;
        const poster = aniData?.coverImage?.extraLarge || aniData?.coverImage?.large || `https://ui-avatars.com/api/?name=${encodeURIComponent(seriesName)}&background=6c5ce7&color=fff&size=300&font-size=0.3`;
        const banner = aniData?.bannerImage || `https://picsum.photos/seed/bg/${encodeURIComponent(seriesName)}/1200/600`;
        const description = aniData?.description ? aniData.description.substring(0, 500) + "..." : `Seriál: ${seriesName}`;

        return {
            meta: {
                id: id,
                type: 'movie',
                name: title,
                poster: poster,
                background: banner,
                description: description,
            }
        };
    } catch (error) {
        console.error("Meta Error:", error.message);
        return { meta: null };
    }
};

const streamHandler = async (id, extra) => {
    const rdToken = extra.rd_token;
    if (!rdToken) throw new Error("Chybí RD token.");

    const originalTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
    
    // 1. STREAM CACHE CHECK
    const cachedStream = streamCache.get(id);
    if (cachedStream && cachedStream.magnet) {
        console.log(`Stream z CACHE: ${cachedStream.title.substring(0, 30)}...`);
        try {
            const rdLink = await getRdStreamLink(cachedStream.magnet, rdToken);
            return { streams: [{ title: `RD 1080p`, url: rdLink }] };
        } catch (e) {
            console.error("RD Cache Link selhal, zkouším RSS...");
        }
    }

    // 2. RSS SEARCH
    console.log(`Nenalezeno v cache, hledám v RSS: ${originalTitle.substring(0, 30)}...`);
    
    let item = rssItems.find(i => {
        const t = (Array.isArray(i.title) ? i.title[0] : i.title || "").trim().normalize('NFC');
        const s = originalTitle.trim().normalize('NFC');
        return t === s;
    });

    // 3. HASH SEARCH
    if (!item) {
        const hash = extractHash(originalTitle);
        if (hash) {
            item = rssItems.find(i => {
                const t = (Array.isArray(i.title) ? i.title[0] : i.title || "");
                return t.includes(`[${hash}]`);
            });
        }
    }

    // 4. LIVE FETCH
    if (!item) {
        await updateRssCache();
        
        item = rssItems.find(i => {
            const t = (Array.isArray(i.title) ? i.title[0] : i.title || "").trim().normalize('NFC');
            const s = originalTitle.trim().normalize('NFC');
            return t === s;
        });

        if (!item) {
             const hash = extractHash(originalTitle);
             if (hash) {
                item = rssItems.find(i => {
                    const t = (Array.isArray(i.title) ? i.title[0] : i.title || "");
                    return t.includes(`[${hash}]`);
                });
            }
        }
    }
    
    if (!item) {
        throw new Error("Epizoda nenalezena v RSS.");
    }

    const magnetLink = extractMagnet(item);

    if (!magnetLink) {
        throw new Error("Magnet nenalezen.");
    }

    // NEUKLÁDÁME DO CACHE PRO STREAM, pokud je nový
    // Pokud selhali na cache, chceme uložit novou cestu
    if (!cachedStream) {
        streamCache.set(id, { magnet: magnetLink, title: originalTitle });
    }

    console.log(`Stream start: ${originalTitle.substring(0, 30)}...`);
    
    try {
        const rdLink = await getRdStreamLink(magnetLink, rdToken);
        return { streams: [{ title: `RD 1080p`, url: rdLink }] };
    } catch (error) {
        // Pokud RD selhal, vyhodíme chybu, aby Stremio vědělo, že stream není dostupný
        console.error("Final Stream Error:", error.message);
        throw error;
    }
};

// --- ROUTING ---

app.get('/manifest.json', (req, res) => {
    console.log("GET /manifest.json");
    res.json(manifestObj);
});

app.get('/catalog/:type/:id.json', async (req, res) => {
    console.log(`GET /catalog/${req.params.type}/${req.params.id}.json`);
    try {
        const config = getReqConfig(req);
        const data = await catalogHandler(config);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/meta/:type/:id.json', async (req, res) => {
    console.log(`GET /meta/${req.params.type}/${req.params.id}.json`);
    let id = req.params.id;
    if (id.endsWith('.json')) id = id.substring(0, id.length - 5);
    
    try {
        const extra = getReqConfig(req);
        const data = await metaHandler(id, extra);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    console.log(`GET /stream/${req.params.type}/${req.params.id}.json`);
    let id = req.params.id;
    if (id.endsWith('.json')) id = id.substring(0, id.length - 5);

    try {
        const extra = getReqConfig(req);
        const data = await streamHandler(id, extra);
        res.json(data);
    } catch (error) {
        console.error(error);
        // Pokud dojde k chybě (např. timeout), vrátíme chybu 500. Stremio to zobrazí jako chybu, ne jako spinner.
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/ui.html');
});

// --- INIT ---
(async () => {
    console.log("Inicializuji RSS před startem...");
    await updateRssCache();
    console.log("RSS načteno. Spouštím server...");
    
    setInterval(updateRssCache, 5 * 60 * 1000);
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server běží na portu: ${PORT}`);
    });
})();