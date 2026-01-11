console.log(">>> SPAUŠTĚNÍ WEB UI V49C (FOLDER CHECK FIRST) <<<");

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "SubsPlease RD v49c";
const CACHE_MAX_AGE = 4 * 60 * 60; 
const SUBSPLEASE_RSS = 'https://subsplease.org/rss/?r=1080';
const ANILIST_API = 'https://graphql.anilist.co';

// Seznam trackerů
const TRACKERS = 'tr=http://nyaa.tracker.wf:7777/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.stealth.si:80/announce&tr=udp://exodus.desync.com:6969/announce&tr=udp://tracker.torrent.eu.org:451/announce&tr=http://tracker.mywaifu.best:6969/announce&tr=https://tracker.zhuqiy.com:443/announce&tr=udp://tracker.tryhackx.org:6969/announce&tr=udp://retracker.hotplug.ru:2710/announce&tr=udp://tracker.dler.com:6969/announce&tr=http://tracker.beeimg.com:6969/announce&tr=udp://t.overflow.biz:6969/announce&tr=wss://tracker.openwebtorrent.com';

// CACHE & PROMĚNNÉ
let rssItems = [];
let metadataCache = new Map(); 
let streamCache = new Map(); 
let lastRssUpdate = 0;

// --- MANIFEST OBJEKT ---
const manifestObj = {
    id: 'community.subsplease.rd.v49c',
    version: '40.0.2', // Oprava verze
    name: ADDON_NAME,
    description: 'SubsPlease Addon - Folder Check Fix',
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

// EXTRAKCE MAGNETU
function extractMagnet(item) {
    if (!item) return null;

    if (item.link) {
        const linkVal = Array.isArray(item.link) ? item.link[0] : item.link;
        if (linkVal && linkVal.startsWith('magnet:')) return linkVal;
        if (linkVal.$ && linkVal.$.url && linkVal.$.url.startsWith('magnet:')) return linkVal.$.url;
    }

    if (item.enclosure) {
        let enc = item.enclosure;
        if (Array.isArray(enc)) enc = enc[0];
        const url = enc.$ ? enc.$.url : enc.url;
        if (url && url.startsWith('magnet:')) return url;
        if (enc.url && enc.url.startsWith('magnet:')) return enc.url;
    }

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
    if (now - lastRssUpdate < 10 * 1000) return;
    
    try {
        console.log("Aktualizuji RSS...");
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
            timeout: 10000
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

// --- REAL-DEBRID API (PROVEN LOGIC) ---
async function getRdStreamLink(magnetLink, rdToken) {
    try {
        // 1. ADD MAGNET
        console.log("RD: Přidávám magnet...");
        const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            `magnet=${encodeURIComponent(magnetLink)}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 15000 }
        );
        const torrentId = addRes.data.id;
        
        // 2. FILE SELECTION
        console.log("RD: Získávám info...");
        const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
            { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 25000 }
        );
        
        const status = infoRes.data.status;
        const files = infoRes.data.files || [];

        if (status === 'magnet_error') throw new Error('RD: Torrent je neplatný.');
        if (status === 'error') throw new Error('RD: Fatal chyba.');
        if (status === 'waiting_files_selection' && files.length > 0) {
            console.log("RD: Vybírám video soubor...");
            let fileId = "all";
            const videoFiles = files.filter(f => f.path.match(/\.(mp4|mkv|avi)$/i));
            if (videoFiles.length > 0) {
                videoFiles.sort((a, b) => b.bytes - a.bytes);
                fileId = videoFiles[0].id;
            }
            
            await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
                `files=${fileId}`, 
                { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 10000 }
            );
            await new Promise(r => setTimeout(r, 1000)); 
        }

        // 3. POLLING (UNRESTRICT LOGIC)
        console.log("RD: Spouštím polling (čekám na stažení)...");
        let maxAttempts = 30; 
        
        while (maxAttempts-- > 0) {
            if (maxAttempts < 29) {
                await new Promise(r => setTimeout(r, 2000));
            }

            const pollRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, 
                { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 25000 }
            );
            
            const pollStatus = pollRes.data.status;
            const pollLinks = pollRes.data.links;

            if (pollStatus === 'downloaded' && pollLinks && pollLinks.length > 0) {
                const linkItem = pollLinks[0];
                let rawLink = null;

                if (typeof linkItem === 'string') {
                    rawLink = linkItem;
                } else if (typeof linkItem === 'object') {
                    rawLink = linkItem.link || linkItem.download; 
                }

                if (rawLink && rawLink.startsWith('http')) {
                    console.log("RD: Nalezen link, volám /unrestrict/link...");
                    try {
                        const unrestrictRes = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', 
                            `link=${encodeURIComponent(rawLink)}`, 
                            { headers: { 'Authorization': `Bearer ${rdToken}` }, timeout: 15000 }
                        );
                        
                        // Priority -> download (pro starý kód logiku)
                        if (unrestrictRes.data.download && unrestrictRes.data.download.startsWith('http')) {
                            console.log("RD: Unrestrict URL získána.");
                            return unrestrictRes.data.download;
                        }
                    } catch (e) {
                        rawLink = null;
                    }
                }
            }
        }

        throw new Error("RD: Časový limit.");
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
    // 1. FOLDER CHECK FIRST (OPRAVA PÁDŮ)
    // Před jakýmkoliv jiným operacemi, zkontrolujeme, zda ID je složka.
    // 'subsplease' je název addonu/manifestu nebo název katalogu často používaný jako ID složky.
    let cleanId = id;
    if (cleanId.endsWith('.json')) cleanId = cleanId.substring(0, cleanId.length - 5);

    if (cleanId === 'subsplease' || cleanId === 'subsplease-feed') {
        console.warn(`POŽADAVEK NA SLOŽKU (ID: "${cleanId}") - Vracím prázdné streamy.`);
        return { streams: [] }; // Vracíme prázdné pole, což pro Stremio znamená "nic sem nepřehrej"
    }

    // 2. RD TOKEN CHECK
    const rdToken = extra.rd_token;
    if (!rdToken) throw new Error("Chybí RD token.");

    // 3. DEKÓDOVÁNÍ ID (Teprve nyní, pokud to není složka)
    const originalTitle = Buffer.from(id.replace('subsplease:', ''), 'base64').toString('utf-8');
    
    // 4. STREAM CACHE
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

    // 5. RSS SEARCH
    console.log(`Nenalezeno v cache, hledám v RSS: ${originalTitle.substring(0, 30)}...`);
    
    let item = rssItems.find(i => {
        const t = (Array.isArray(i.title) ? i.title[0] : i.title || "").trim().normalize('NFC');
        const s = originalTitle.trim().normalize('NFC');
        return t === s;
    });

    // 6. HASH SEARCH
    if (!item) {
        const hash = extractHash(originalTitle);
        if (hash) {
            item = rssItems.find(i => {
                const t = (Array.isArray(i.title) ? i.title[0] : i.title || "");
                return t.includes(`[${hash}]`);
            });
        }
    }

    // 7. LIVE FETCH
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
    if (!magnetLink) throw new Error("Magnet nenalezen.");

    // 8. HASH INJECTION FALLBACK
    if (!item) {
        console.log("Epizoda nenalezena v RSS. Zkouším Hash Injection...");
        const hash = extractHash(originalTitle);
        
        if (hash) {
            const paddedHash = hash.padEnd(40, '0');
            const magnetUrl = `magnet:?xt=urn:btih:${paddedHash}&dn=${encodeURIComponent(originalTitle)}&${TRACKERS}`;
            console.log(`Magnet vytvořen z hashu: ${magnetUrl.substring(0, 60)}...`);
            
            streamCache.set(id, { magnet: magnetUrl, title: originalTitle });

            console.log(`Stream start (Hash): ${originalTitle.substring(0, 30)}...`);
            try {
                const rdLink = await getRdStreamLink(magnetUrl, rdToken);
                return { streams: [{ title: `RD 1080p (Hash)`, url: rdLink }] };
            } catch (e) {
                console.error("Hash Injection selhal:", e.message);
                throw new Error("Epizoda nenalezena v RSS ani v Hash Injection.");
            }
        }
    }

    // 9. FINAL URL GET
    const magnetLinkFinal = extractMagnet(item);
    if (!magnetLinkFinal) throw new Error("Magnet nenalezen.");

    streamCache.set(id, { magnet: magnetLinkFinal, title: originalTitle });

    console.log(`Stream start: ${originalTitle.substring(0, 30)}...`);
    
    try {
        const rdLink = await getRdStreamLink(magnetLinkFinal, rdToken);
        return { streams: [{ title: `RD 1080p`, url: rdLink }] };
    } catch (error) {
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