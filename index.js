console.log(">>> ZAHÁJENÍ V6 (ODEBRÁNA NEEXISTUJÍCÍ METODA) <<<");

const sdk = require('stremio-addon-sdk');
const addonBuilder = sdk.addonBuilder;
const serveHTTP = sdk.serveHTTP;

const axios = require('axios');
const xml2js = require('xml2js');

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v6";
const CACHE_MAX_AGE = 4 * 60 * 60; 
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';

// Získání klíče
const getRdKey = (args) => {
    // 1. Zkusíme z standardní konfigurace (pokud by fungovala)
    if (args.config && args.config.rd_token) return args.config.rd_token;
    // 2. Zkusíme z URL parametru (např. manifest.json?token=ABC123)
    if (args.extra && args.extra.token) return args.extra.token;
    return null;
};

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

const catalogHandler = async ({ config }) => {
    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        const metas = items.map(item => {
            const title = item.title?.[0] || "Unknown";
            const pubDate = item.pubDate?.[0] || "";
            const descHtml = item.description?.[0] || "";
            const match = descHtml.match(/href="([^"]+)"/);
            const magnetLink = match ? match[1] : null;
            const id = `subsplease:${Buffer.from(title).toString('base64').substring(0, 20)}`;

            return {
                id: id,
                type: 'movie',
                name: title,
                poster: `https://picsum.photos/seed/${encodeURIComponent(title)}/200/300`,
                description: `Vydáno: ${new Date(pubDate).toLocaleString()}`,
                subsplease_magnet: magnetLink 
            };
        });
        return { metas };
    } catch (error) {
        console.error("RSS Error:", error.message);
        return { metas: [] };
    }
};

const streamHandler = async (args) => {
    const rdToken = getRdKey(args);
    if (!rdToken) throw new Error("Chybí RD token.");

    try {
        const response = await axios.get(SUBSPLEASE_RSS);
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const items = result.rss?.channel?.[0]?.item || [];
        
        const base64Title = args.id.replace('subsplease:', '');
        const decodedTitle = Buffer.from(base64Title, 'base64').toString('utf-8');
        const item = items.find(i => (i.title?.[0] || "").startsWith(decodedTitle.substring(0, 15)));
        
        if (!item || !item.description?.[0]) throw new Error("Item nenalezen.");
        const descHtml = item.description[0];
        const match = descHtml.match(/href="([^"]+)"/);
        const magnetLink = match ? match[1] : null;

        if (!magnetLink) throw new Error("Magnet nenalezen.");

        const rdLink = await getRdStreamLink(magnetLink, rdToken);
        return { streams: [{ title: `RD 1080p`, url: rdLink }] };
    } catch (error) {
        console.error(error);
        throw error;
    }
};

// --- VYTVOŘENÍ ADDONU ---
// Odstranili jsme configurationRequired, protože nemáme definované UI pro config
const addon = addonBuilder({
    id: 'community.subsplease.rd.v6',
    version: '1.6.0',
    name: ADDON_NAME,
    description: 'SubsPlease + Real-Debrid Addon v6',
    logo: 'https://picsum.photos/seed/icon/200/200',
    background: 'https://picsum.photos/seed/bg/1200/600',
    types: ['movie', 'series'],
    resources: ['catalog', 'stream', 'meta'],
    catalogs: [{ type: 'movie', id: 'subsplease-feed', name: 'Nejnovější epizody' }],
    // Nastavení UI configu zablokovalo server, používáme fallback do URL
});

// --- PŘIPOJENÍ HANDLERŮ ---
addon.defineCatalogHandler(catalogHandler);
addon.defineStreamHandler(streamHandler);

// POZOR: configHandler jsme odstranili, protože neexistuje v SDK!

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
serveHTTP(addon, { port: PORT, cache: CACHE_MAX_AGE })
    .then(({ url }) => {
        console.log(`Addon běží: ${url}`);
        console.log(`Vložte URL do Stremia: ${url}/manifest.json`);
    });