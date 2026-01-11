console.log(">>> SPAUŠTĚNÍ WEB UI V33 (PRIORITIZOVANÝ LINK) <<<");

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v33";
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
    id: 'community.subsplease.rd.v33',
    version: '23.0.0',
    name: ADDON_NAME,
    description: 'SubsPlease Addon - Link Priority',
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

// EXTRAKCE MAGNETU (FINAL FIX)
function extractMagnet(item) {
    // Priorita 1: XML tag <link> (Hlavní odkaz)
    // Toto je standardní způsob, jak RSS feedy posílají magnety
    if (item.link) {
        // xml2js vrací link jako string nebo array podle verze/parseru
        const linkVal = Array.isArray(item.link) ? item.link[0] : item.link;
        if (linkVal && linkVal.startsWith('magnet:')) return linkVal;
    }

    // Priorita 2: <enclosure> tag
    if (item.enclosure) {
        let enc = item.enclosure;
        if (Array.isArray(enc)) enc = enc[0];
        // xml2js s mergeAttrs ukládá atributy do $         if (enc.$ && enc.$.url) {
            if (enc.$.url.startsWith('magnet:')) return enc.$.url;
        }
        // Záloha pro starší parser verze (přímý atribut)
        if (enc.url && enc.url.startsWith('magnet:')) return enc.url;
    }

    // Priorita 3: <description> (HTML parse)
    let desc = item.description;
    if (Array.isArray(desc)) desc = desc[0];
    if (typeof desc !== 'string') desc = "";
    
    const match = desc.match(/href=(["'])(.*?)\1/);
    if (match && match[2]) {
        if (match[2].startsWith('magnet:')) return match[2];
    }
    
    return null;
}

// Aktualizace RSS
async function updateRssCache() {
    const now = Date.now();
    if (now - lastRssUpdate < 10 * 1000) {
        return;
    }
    
    try {
        console.log("Aktualizuji RSS...");
        const response = await axios.get(SUBSPLEASE_RSS);
        // mergeAttrs: true zajistí, že enclosure u atributy zachytí
        const parser = new xml2js.Parser({ trim: true, explicitArray: false, mergeAttrs: true });
        const result = await parser.parseStringPromise(response.data);
        
        const channelData = result.rss?.channel;
        const channel = Array.isArray(channelData) ? channelData[0] : channelData;
        
        rssItems = channel?.item || [];
        lastRssUpdate = now;
        
        console.log(`RSS Cache aktualizována. Načteno ${rssItems.length} položek.`);
    } catch (error) {
        console.error("Chyba aktualizace RSS Cache:", error.message);
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
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
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

// --- REAL-DEBRID API ---
async function getRdStreamLink(magnetLink, rdToken) {
    try {
        const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        const torrentId = addRes.data.id;
        const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        let files = infoRes.data.files || [];
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
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        const linksRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` } }
        );
        if (linksRes.data.links && linksRes.data.links.length > 0) {
            return linksRes.data.links[0];
        } else {
            throw new Error("Link není připraven.");
        }
    } catch (error) {
        console.error("RD Error:", error.response?.data || error.message);
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
        } else {
             console.log(`WARNING: Magnet nenalezen pro: ${title.substring(0, 30)}...`);
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
    
    console.log(`Katalog vrácen: ${metas.length} položek. Cache velikost: ${streamCache.size}`);
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
    
    // 1. PERSISTENT CACHE CHECK
    let item = null;
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
    
    item = rssItems.find(i => {
        const t = (Array.isArray(i.title) ? i.title[0] : i.title || "").trim().normalize('NFC');
        const s = originalTitle.trim().normalize('NFC');
        return t === s;
    });

    // 3. LIVE FETCH + HASH
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
        throw new Error("Epizoda nenalezena v RSS (je příliš stará).");
    }

    // FINÁLNÍ EXTRAKCE MAGNETU (S ITEM.LINK)
    const magnetLink = extractMagnet(item);

    if (!magnetLink) {
        throw new Error("Magnet nenalezen ani v item.link ani v description.");
    }

    // Aktualizace cache
    streamCache.set(id, { magnet: magnetLink, title: originalTitle });

    console.log(`Stream start: ${originalTitle.substring(0, 30)}...`);
    
    const rdLink = await getRdStreamLink(magnetLink, rdToken);
    return { streams: [{ title: `RD 1080p`, url: rdLink }] };
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