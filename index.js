console.log(">>> SPAUŠTĚNÍ WEB UI V16 (Pouze Název Seriálu) <<<");

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v16";
const CACHE_MAX_AGE = 4 * 60 * 60; 
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';
const ANILIST_API = 'https://graphql.anilist.co';

// CACHE & PROMĚNNÉ
let rssItems = [];
let metadataCache = new Map(); // Klíč bude název seriálu (např. "One Piece")

// --- MANIFEST OBJEKT ---
const manifestObj = {
    id: 'community.subsplease.rd.v16',
    version: '6.0.0',
    name: ADDON_NAME,
    description: 'SubsPlease Addon - Hledání podle názvu seriálu',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['series'],
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [{ type: 'series', id: 'subsplease-feed', name: 'Nejnovější epizody' }],
    behaviorHints: { configurable: false }
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

// Aktualizace RSS
async function updateRssCache() {
    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        rssItems = result.rss?.channel?.[0]?.item || [];
        console.log(`RSS Cache aktualizována. Načteno ${rssItems.length} položek.`);
    } catch (error) {
        console.error("Chyba aktualizace RSS Cache:", error.message);
    }
}
updateRssCache();
setInterval(updateRssCache, 5 * 60 * 1000);

// FUNKCE PRO EXTRAKCI NÁZVU SERIÁLU
// Z "One Piece - 1092" udělá "One Piece"
function extractSeriesName(fullTitle) {
    // 1. Odstraníme vše v hranatých závorkách [SubsPlease], [1080p] atd.
    let clean = fullTitle.replace(/\[.*?\]/g, '').trim();
    
    // 2. Rozdělíme podle pomlčky " - " (standardní formát SubsPlease je Název - Číslo)
    const parts = clean.split(/\s+-\s+/);
    
    // Vrátíme první část (název seriálu)
    return parts[0].trim();
}

// --- ANILIST INTEGRACE ---
async function getAniListMeta(fullTitle) {
    const seriesName = extractSeriesName(fullTitle);
    
    // Pokud už máme metadata pro tento seriál, vrátíme je
    if (metadataCache.has(seriesName)) {
        return metadataCache.get(seriesName);
    }

    console.log(`Hledám AniList pro seriál: "${seriesName}"`);

    const query = `
        query ($search: String) {
          Media(search: $search, type: ANIME) {
            id
            title { romaji english }
            description
            coverImage { extraLarge large }
            bannerImage
            genres
            status
            seasonYear
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

        const media = response.data.data.Media;
        if (media) {
            metadataCache.set(seriesName, media); // Uložíme pod názvem seriálu
            return media;
        } else {
            console.log(`AniList nenašel: ${seriesName}`);
        }
        return null;
    } catch (error) {
        if (error.response?.status === 404) {
            console.log(`AniList 404 pro: ${seriesName}`);
        } else {
            console.error("AniList Error:", error.message);
        }
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
    if (rssItems.length === 0) {
        await new Promise(r => setTimeout(r, 1000));
    }

    const metas = rssItems.map(item => {
        const title = item.title?.[0] || "Unknown";
        const pubDate = item.pubDate?.[0] || "";
        const descHtml = item.description?.[0] || "";
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;
        
        const id = `subsplease:${Buffer.from(title).toString('base64')}`;
        
        // Placeholder poster - použijeme název seriálu pro generování avataru, aby to bylo konzistentní
        const seriesName = extractSeriesName(title);
        const poster = `https://ui-avatars.com/api/?name=${encodeURIComponent(seriesName)}&background=6c5ce7&color=fff&size=300&font-size=0.3`;

        return {
            id: id,
            type: 'series',
            name: title,
            poster: poster,
            background: `https://picsum.photos/seed/bg/${encodeURIComponent(seriesName)}/1200/600`,
            description: `Vydáno: ${new Date(pubDate).toLocaleString()}\nSeriál: ${seriesName}`,
            subsplease_magnet: magnetLink,
            originalTitle: title
        };
    });
    return { metas };
};

const metaHandler = async (id, extra) => {
    try {
        const originalTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
        
        // Načítáme metadata podle názvu seriálu
        const aniData = await getAniListMeta(originalTitle);

        const seriesName = aniData 
            ? (aniData.title.english || aniData.title.romaji) 
            : extractSeriesName(originalTitle);

        return {
            meta: {
                id: id,
                type: 'series',
                name: originalTitle, // Zobrazujeme název epizody v záhlaví
                poster: aniData ? aniData.coverImage.extraLarge : '',
                background: aniData ? aniData.bannerImage : '',
                description: aniData ? aniData.description.replace(/<[^>]*>/g, '').substring(0, 500) + "..." : '',
                genres: aniData ? aniData.genres : ['Anime'],
                videos: [{ title: originalTitle, released: new Date().toISOString() }]
            }
        };
    } catch (error) {
        console.error("Meta Error:", error);
        return { meta: null };
    }
};

const streamHandler = async (id, extra) => {
    const rdToken = extra.rd_token;
    if (!rdToken) throw new Error("Chybí RD token.");

    try {
        const originalTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
        
        const item = rssItems.find(i => (i.title?.[0] || "") === originalTitle);
        
        if (!item || !item.description?.[0]) {
            throw new Error("Epizoda nenalezena v RSS cache.");
        }
        
        const descHtml = item.description[0];
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;

        if (!magnetLink) throw new Error("Magnet nenalezen.");

        const rdLink = await getRdStreamLink(magnetLink, rdToken);
        return { streams: [{ title: `RD 1080p`, url: rdLink }] };
    } catch (error) {
        console.error("Stream Error:", error.message);
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
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/ui.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server běží na portu: ${PORT}`);
});