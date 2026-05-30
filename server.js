require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// SECURITY: Helmet headers
app.use(helmet());

// SECURITY: Rate Limiting
// const limiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15 minutes
//     max: 1000, // Limit each IP to 1000 requests per windowMs
//     message: { error: "Too many requests from this IP, please try again later." },
//     standardHeaders: true,
//     legacyHeaders: false,
// });
// app.use(limiter); // User requested infinite requests, so rate limiter is disabled

// SECURITY: CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());

// CONFIGURATION (Moved to Environment Variables)
const MONGO_URI = process.env.MONGO_URI;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME || "foodi";
const APP_API_KEY = process.env.APP_API_KEY;
const GASTRO_CDN_BASE = process.env.GASTRO_CDN_BASE || "https://yemek-resimler.aykutakcay85.workers.dev";

if (!MONGO_URI || !APP_API_KEY) {
    console.error("❌ CRITICAL: Missing required environment variables (MONGO_URI or APP_API_KEY)");
    process.exit(1);
}

console.log("🚀 Server starting...");


// CLIENTS
const mongoClient = new MongoClient(MONGO_URI);

// R2 Endpoint temizleme (SSL hatalarını önlemek için)
let cleanEndpoint = R2_ENDPOINT.trim();
if (!cleanEndpoint.startsWith('http')) cleanEndpoint = `https://${cleanEndpoint}`;
// Eğer sonunda /foodi veya / kova adı varsa temizle
cleanEndpoint = cleanEndpoint.replace(/\/+$/, '').replace(/\/[a-zA-Z0-9._-]+$/, (match) => {
    // Sadece /foodi gibi kısımları, eğer .com veya .net sonrası geliyorsa temizle
    return match.includes('cloudflarestorage.com') ? match : '';
});
// Daha basit ve kesin yöntem: Sadece hostname kısmını al
try {
    const url = new URL(cleanEndpoint);
    cleanEndpoint = `${url.protocol}//${url.hostname}`;
} catch (e) {
    console.warn("⚠️ Endpoint URL parse hatası, ham değer kullanılıyor.");
}

const s3Client = new S3Client({
    region: "auto",
    endpoint: cleanEndpoint,
    forcePathStyle: true,
    credentials: {
        accessKeyId: R2_ACCESS_KEY,
        secretAccessKey: R2_SECRET_KEY,
    },
});

// SECURITY: API KEY
// Moved to process.env.APP_API_KEY

function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    // Allow public access to ping and images
    if (req.path === '/ping' || req.path.startsWith('/gastro_images/') || req.path.startsWith('/images/')) {
        return next();
    }
    
    if (apiKey && apiKey === APP_API_KEY) {
        next();
    } else {
        console.warn(`🚨 Unauthorized access attempt from IP: ${req.ip} for path: ${req.path}`);
        res.status(401).json({ error: "Unauthorized access. Invalid API Key." });
    }
}

app.use(authenticate);

function getCategoryQuery(category) {
    const cat = category.toLowerCase().trim();
    if (cat === 'all') return {};
    if (cat === 'gastro') return { c: { $regex: '^gastro$', $options: 'i' } };
    if (cat === 'chef_pro' || cat === 'chef' || cat.includes('chef')) {
        return { c: { $regex: '^chef_pro$', $options: 'i' } };
    }

    const mapping = {
        // Main Dishes / Aksam yemegi
        'main': 'Main Dishes|Et Yemekleri|Tavuk Yemekleri|Bal[ıİ.]k Yemekleri|Kebap|K[öÖ.]fte|Sebze Yemekleri|Dolma-Sarma|Bakliyat|Pilav|Makarna|Ana Yemek',
        'main course': 'Main Dishes|Et Yemekleri|Tavuk Yemekleri|Bal[ıİ.]k Yemekleri|Kebap|K[öÖ.]fte|Sebze Yemekleri|Dolma-Sarma|Bakliyat|Pilav|Makarna|Ana Yemek',
        'ana yemek': 'Main Dishes|Et Yemekleri|Tavuk Yemekleri|Bal[ıİ.]k Yemekleri|Kebap|K[öÖ.]fte|Sebze Yemekleri|Dolma-Sarma|Bakliyat|Pilav|Makarna|Ana Yemek',
        'aksam_yemegi': 'Main Dishes|Et Yemekleri|Tavuk Yemekleri|Bal[ıİ.]k Yemekleri|Kebap|K[öÖ.]fte|Sebze Yemekleri|Dolma-Sarma|Bakliyat|Pilav|Makarna|Ana Yemek',

        // Appetizer / Meze
        'appetizer': 'Appetizer|Meze|Ba[şŞ.]lang[ıİ.][çÇ.]lar|Ara S[ıİ.]cak|Zeytinya[ğĞ.]l[ıİ.]lar|Aperatifler',
        'meze': 'Salata & Meze & Kanepe|Meze|Aperatifler',
        'baslangic': 'Ba[şŞ.]lang[ıİ.][çÇ.]lar|Ara S[ıİ.]cak|Aperatifler',
        'atistirmalik': 'Aperatifler|Kurabiye Tarifleri',
        'aperatifler': 'Aperatifler',
        'tuzlu_atistirmalik': 'Aperatifler|Kurabiye Tarifleri',

        // Breakfast
        'breakfast': 'Breakfast|Kahvalt[ıİ.]|Kahvalt[ıİ.]l[ıİ.]k',
        'kahvalti': 'Breakfast|Kahvalt[ıİ.]|Kahvalt[ıİ.]l[ıİ.]k',
        'kahvaltilik': 'Breakfast|Kahvalt[ıİ.]l[ıİ.]k',
        'kahvaltilik_tarifler': 'Kahvalt[ıİ.]l[ıİ.]k Tarifler',
        'tost': 'Kahvalt[ıİ.]l[ıİ.]k Tarifler',

        // Soup
        'soup': 'Soup|[Çç.]orba Tarifleri|[Çç.]orbalar|Soups',
        'corba': 'Soup|[Çç.]orba Tarifleri|[Çç.]orbalar',
        'corba_tarifleri': '[Çç.]orba Tarifleri',

        // Dessert / Tatli
        'dessert': 'Dessert|Tatl[ıİ.] Tarifleri|Tatl[ıİ.]lar|Pastalar|Kurabiyeler|Desserts|dessert',
        'tatli': 'Dessert|Tatl[ıİ.] Tarifleri|Tatl[ıİ.]lar|Pastalar|Kurabiyeler|Desserts|dessert',
        'tatli_tarifleri': 'Tatl[ıİ.] Tarifleri',
        'cikolatali_tatli': 'Tatl[ıİ.] Tarifleri|Desserts',
        'dondurma': 'Tatl[ıİ.] Tarifleri|Desserts',
        'helva': 'Tatl[ıİ.] Tarifleri',
        'meyveli_tatli': 'Tatl[ıİ.] Tarifleri',
        'serbetli_tatli': 'Tatl[ıİ.] Tarifleri',
        'sutlu_tatli': 'Tatl[ıİ.] Tarifleri',
        'tatli_atistirmalik': 'Kurabiye Tarifleri|Tatl[ıİ.] Tarifleri',
        'tatli_kek': 'Hamur [İi.][şŞ.]i Tarifleri|Tatl[ıİ.] Tarifleri',
        'tatli_kurabiye': 'Kurabiye Tarifleri|Tatl[ıİ.] Tarifleri',

        // Salad
        'salad': 'Salad|Salata|Salatalar|Salads',
        'salata': 'Salad|Salata|Salatalar|Salads',

        // Bread / Dough
        'bread': 'Bread|Bakery|Ekmek|Hamur [İi.][şŞ.]i Tarifleri|B[öÖ.]rek|Poga[çÇ.]a|Pizzalar|Breads',
        'bakery': 'Bread|Bakery|Ekmek|Hamur [İi.][şŞ.]i Tarifleri|B[öÖ.]rek|Poga[çÇ.]a|Pizzalar|Breads',
        'hamur': 'Hamur [İi.][şŞ.]i Tarifleri',
        'borek': 'Hamur [İi.][şŞ.]i Tarifleri',
        'corek': 'Hamur [İi.][şŞ.]i Tarifleri',
        'ekmek': 'Bread|Breads|BREADS|bread',
        'hamur_isi': 'Hamur [İi.][şŞ.]i Tarifleri',
        'hamur_isi_tarifleri': 'Hamur [İi.][şŞ.]i Tarifleri',
        'pide': 'Hamur [İi.][şŞ.]i Tarifleri',
        'pogaca': 'Hamur [İi.][şŞ.]i Tarifleri',
        'manti': 'Hamur [İi.][şŞ.]i Tarifleri',

        // Sauce
        'sauce': 'Sauce|Sos|Soslar|sauce',
        'sos': 'Sauce|Sos|Soslar|sauce',

        // Beverages
        'beverage': 'Beverage|[İi.]ecek Tarifleri|[İi.]ecekler|Kokteyller|BEVERAGES|Beverages|drink',
        'icecek': 'Beverage|[İi.]ecek Tarifleri|[İi.]ecekler|Kokteyller|BEVERAGES|Beverages|drink',
        'icecek_tarifleri': '[İi.]ecek Tarifleri|BEVERAGES|Beverages|drink',

        // Preserves
        'preserve': 'Preserve|Re[çÇ.]el|Konserve|K[ıİ.][şŞ.] Haz[ıİ.]rl[ıİ.]klar[ıİ.]|Tur[şŞ.]ular|Di[ğĞ.]er Tarifler',
        'konserve': 'Preserve|Re[çÇ.]el|Konserve|K[ıİ.][şŞ.] Haz[ıİ.]rl[ıİ.]klar[ıİ.]|Tur[şŞ.]ular',
        'recel': 'Di[ğĞ.]er Tarifler',
        'kis_hazirliklari': 'Di[ğĞ.]er Tarifler',
        'tursu': 'Di[ğĞ.]er Tarifler',

        // Other
        'other': 'Other|Di[ğĞ.]er Tarifler|Di[ğĞ.]er',
        'diger': 'Other|Di[ğĞ.]er Tarifler|Di[ğĞ.]er',
        'diger_tarifler': 'Di[ğĞ.]er Tarifler',
        'sizden_gelenler': 'Other|Di[ğĞ.]er Tarifler',
        'mevsiminde': 'Other|Di[ğĞ.]er Tarifler',

        // Specific Turkish categories
        'bakliyat': 'Bakliyat Yemekleri',
        'bakliyat_yemekleri': 'Bakliyat Yemekleri',
        'balik': 'Bal[ıİ.]k|Seafood|Main Dishes: Seafood',
        'deniz_urunleri': 'Seafood|Main Dishes: Seafood',
        'bebek': 'Bebekler [İi.][çÇ.]in',
        'bebekler_icin': 'Bebekler [İi.][çÇ.]in',
        'diyet': 'Diyet Yemekleri|Diyetler',
        'diyet_yemekleri': 'Diyet Yemekleri',
        'diyetler': 'Diyetler',
        'glutensiz': 'Diyet Yemekleri',
        'ozel_beslenme': 'Diyet Yemekleri',
        'vegan': 'Diyet Yemekleri|Main Dishes: Vegetarian',
        'vejetaryen': 'Diyet Yemekleri|Main Dishes: Vegetarian',
        'raw_food': 'Diyet Yemekleri',
        'dolma_sarma': 'Dolma-Sarma Tarifleri',
        'dolmasarma_tarifleri': 'Dolma-Sarma Tarifleri',
        'et': 'Et Yemekleri|Beef|Lamb|Meats',
        'et_yemekleri': 'Et Yemekleri',
        'sakatat': 'Et Yemekleri',
        'firin_yemekleri': 'Et Yemekleri|Sebze Yemekleri',
        'hamburger': 'Aperatifler|H[ıİ.]zl[ıİ.] Yemekler',
        'hizli_yemek': 'H[ıİ.]zl[ıİ.] Yemekler',
        'hizli_yemekler': 'H[ıİ.]zl[ıİ.] Yemekler',
        'kebap': 'Et Yemekleri',
        'kofte': 'Et Yemekleri',
        'kurabiye': 'Kurabiye Tarifleri',
        'kurabiye_tarifleri': 'Kurabiye Tarifleri',
        'makarna': 'Makarna Tarifleri|Pasta',
        'makarna_tarifleri': 'Makarna Tarifleri',
        'pilav': 'Pilav Tarifleri|Rice',
        'pilav_tarifleri': 'Pilav Tarifleri',
        'pizza': 'pizza|Hamur [İi.][şŞ.]i Tarifleri',
        'ramazan': '[İi.].*ftar Men[üÜ.]leri|Et Yemekleri',
        'iftar_menuleri': '[İi.].*ftar Men[üÜ.]leri',
        'sandvic': 'Sandvi[çÇ.] Tarifleri',
        'sandvic_tarifleri': 'Sandvi[çÇ.] Tarifleri',
        'sebze': 'Sebze Yemekleri|Vegetables',
        'sebze_yemekleri': 'Sebze Yemekleri',
        'sulu_yemek': 'Sebze Yemekleri|Et Yemekleri',
        'tavuk': 'Main Dishes: Poultry|Chicken|Et Yemekleri',
        'tuzlu_kurabiye': 'Kurabiye Tarifleri',
        'yoresel_tarifler': 'Et Yemekleri|Sebze Yemekleri',
        'zeytinyagli': 'Sebze Yemekleri|Salata & Meze & Kanepe',
        'annemin_tarifleri': 'Annemin Tarifleri',
        'salata__meze__kanepe': 'Salata & Meze & Kanepe',
        'cocuklar_icin': '[Çç.]ocuklar [İi.][çÇ.]in',
        'yumurta_yemekleri': 'Yumurta Yemekleri',
        'ozel_gunler': '[Öö.]zel G[üÜöÖ.]nler',
        'dunya_mutfaklari': 'Other|Di[ğĞ.]er Tarifler',
        'masterchef': 'chef_pro'
    };

    if (mapping[cat]) {
        return { c: { $regex: mapping[cat], $options: 'i' } };
    }

    const safeCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { c: { $regex: '^' + safeCategory + '$', $options: 'i' } };
}

function normalizeTitle(str) {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove accents
        .replace(/[^a-z0-9]/g, " ")      // Replace special chars with space
        .replace(/\s+/g, "")            // Remove all spaces
        .replace(/\band\b/g, "")        // Remove common words that vary
        .replace(/\bve\b/g, "")
        .replace(/\bwith\b/g, "")
        .trim();
}

// Production backend URL (Render)
const PROD_BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://chef-aykut-backend.onrender.com";

// Cloudflare R2 gastro public domain (direct CDN, no proxy needed)
function _resolveImageUrl(url, category = '') {
    if (!url || typeof url !== 'string' || url === 'null') return '';
    
    const baseUrl = url.split('?v=')[0].trim();
    
    // Check if it belongs to old R2 buckets or Cloudflare Worker — rewrite to prod backend proxy
    if (baseUrl.includes('pub-088807d92556487e97d1ec1df970bc86')) {
        const path = baseUrl.replace(/^https?:\/\/pub-088807d92556487e97d1ec1df970bc86\.r2\.dev/, '');
        return `${PROD_BASE_URL}${path}?v=3`;
    }
    if (baseUrl.includes('pub-f31f36f3d95441bf8e622e620b1cda67')) {
        const path = baseUrl.replace(/^https?:\/\/pub-f31f36f3d95441bf8e622e620b1cda67\.r2\.dev/, '');
        return `${PROD_BASE_URL}${path}?v=3`;
    }
    if (baseUrl.includes('yemek-resimler.aykutakcay85.workers.dev')) {
        // KEEP direct worker URL for Gastro images (super fast, CDN backed, direct to Cloudflare)
        return `${baseUrl}?v=3`;
    }
    
    // Relative filename (no protocol, no assets/)
    if (baseUrl && !baseUrl.startsWith('http') && !baseUrl.startsWith('assets/')) {
        if (category && category.toLowerCase().includes('gastro')) {
            // GASTRO_CDN_BASE env ile Cloudflare'den direkt (proxy yok, çok hızlı)
            if (GASTRO_CDN_BASE) {
                return `${GASTRO_CDN_BASE}/gastro_images/${baseUrl}`;
            }
            return `https://yemek-resimler.aykutakcay85.workers.dev/gastro_images/${baseUrl}?v=3`;
        } else {
            return `${PROD_BASE_URL}/images/${baseUrl}?v=3`;
        }
    }
    
    return url;
}

const chunkCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // Cache for 30 minutes

let gastroRecipesCached = null;
let lastGastroLoadTime = 0;

async function getGastroRecipes() {
    if (gastroRecipesCached && (Date.now() - lastGastroLoadTime < CACHE_TTL)) {
        return gastroRecipesCached;
    }
    
    console.log("📡 Loading all Gastro chunks from R2/Local...");
    const promises = [];
    for (let i = 0; i <= 5; i++) {
        promises.push((async () => {
            const key = `gastro_chunk_${i}.json`;
            const possibleKeys = [key, `foodi/${key}`, `chunks/${key}`];
            let data = null;
            
            // Try R2
            for (const k of possibleKeys) {
                try {
                    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: k });
                    const response = await s3Client.send(command);
                    data = await response.Body.transformToString();
                    if (data) {
                        console.log(`✅ Loaded Gastro chunk ${i} from R2`);
                        break;
                    }
                } catch (err) {
                    // Try next key
                }
            }
            
            // Try local fallback
            if (!data) {
                const fs = require('fs');
                const path = require('path');
                const pathsToTry = [
                    path.join(__dirname, key),
                    path.join(__dirname, '..', key),
                    path.join(__dirname, '..', 'gastro_output', key),
                    path.join(__dirname, 'gastro_output', key)
                ];
                for (const p of pathsToTry) {
                    try {
                        if (fs.existsSync(p)) {
                            data = fs.readFileSync(p, 'utf8');
                            console.log(`✅ Loaded Gastro chunk ${i} from Local Fallback: ${p}`);
                            break;
                        }
                    } catch (e) {}
                }
            }
            
            if (!data) {
                console.warn(`⚠️ Failed to load Gastro chunk ${i}`);
                return [];
            }
            
            try {
                return JSON.parse(data);
            } catch (e) {
                console.error(`❌ Error parsing Gastro chunk ${i}:`, e.message);
                return [];
            }
        })());
    }
    
    const results = await Promise.all(promises);
    const merged = results.flat();
    console.log(`✅ Loaded ${merged.length} Gastro recipes successfully.`);
    gastroRecipesCached = merged;
    lastGastroLoadTime = Date.now();
    return merged;
}

let chefRecipesCached = null;
let lastChefLoadTime = 0;

async function getChefRecipes() {
    if (chefRecipesCached && (Date.now() - lastChefLoadTime < CACHE_TTL)) {
        return chefRecipesCached;
    }
    
    console.log("📡 Loading Chef chunk from R2/Local...");
    const chunkKey = 'chunk_chef.json';
    const possibleKeys = [chunkKey, `foodi/${chunkKey}`, `chunks/${chunkKey}`];
    let data = null;
    
    for (const k of possibleKeys) {
        try {
            const cmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: k });
            const r2res = await s3Client.send(cmd);
            data = await r2res.Body.transformToString();
            if (data) {
                console.log(`✅ Loaded Chef chunk from R2`);
                break;
            }
        } catch (e) {}
    }
    
    if (!data) {
        // Try local
        try {
            const fs = require('fs'), path = require('path');
            const pathsToTry = [
                path.join(__dirname, chunkKey),
                path.join(__dirname, '..', chunkKey)
            ];
            for (const p of pathsToTry) {
                if (fs.existsSync(p)) {
                    data = fs.readFileSync(p, 'utf8');
                    console.log(`✅ Loaded Chef chunk from Local`);
                    break;
                }
            }
        } catch (e) {}
    }
    
    if (!data) {
        console.warn(`⚠️ Failed to load Chef chunk`);
        return [];
    }
    
    try {
        const parsed = JSON.parse(data);
        chefRecipesCached = Array.isArray(parsed) ? parsed : [parsed];
        lastChefLoadTime = Date.now();
        return chefRecipesCached;
    } catch (e) {
        console.error(`❌ Error parsing Chef chunk:`, e.message);
        return [];
    }
}

async function getRecipeFromChunk(chunkId, recipeId, title = '') {
    try {
        let chunkData;
        if (chunkId === 'gastro') {
            chunkData = await getGastroRecipes();
        } else if (chunkId === 'chef') {
            chunkData = await getChefRecipes();
        } else {
            // Legacy chunk loading logic (like chunk_1.json, etc.)
            const key = `chunk_${chunkId}.json`;
            const possibleKeys = [key, `foodi/${key}`, `chunks/${key}`];
            let data;
            
            // Check cache first
            const cacheKey = `chunk_${chunkId}`;
            const cached = chunkCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
                data = cached.data;
            } else {
                for (const k of possibleKeys) {
                    try {
                        const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: k });
                        const response = await s3Client.send(command);
                        data = await response.Body.transformToString();
                        if (data) {
                            chunkCache.set(cacheKey, { data, timestamp: Date.now() });
                            break;
                        }
                    } catch (err) {}
                }
            }
            
            if (!data) {
                for (const k of possibleKeys) {
                    try {
                        const fs = require('fs'), path = require('path');
                        const localPath = path.join(__dirname, k.includes('/') ? k.split('/').pop() : k);
                        if (fs.existsSync(localPath)) {
                            data = fs.readFileSync(localPath, 'utf8');
                            break;
                        }
                    } catch (e) {}
                }
            }
            
            if (!data) return null;
            
            try {
                const parsed = JSON.parse(data);
                chunkData = Array.isArray(parsed) ? parsed : [parsed];
            } catch (jsonErr) {
                try {
                    chunkData = data.trim().split('\n').map(line => JSON.parse(line));
                } catch (jsonlErr) {
                    return null;
                }
            }
        }

        const found = chunkData.find(r => {
            const rid = (r.i || r.id || r.uid || r.url || '').toString();
            const tid = recipeId.toString();
            if (rid && rid === tid) return true;
            
            if (title) {
                const rTitleNorm = normalizeTitle(r.t || r.title || r.name || '');
                const targetTitleNorm = normalizeTitle(title);
                return rTitleNorm === targetTitleNorm;
            }
            return false;
        });

        return found || null;
    } catch (err) {
        console.error(`🔥 getRecipeFromChunk Error:`, err.message);
        return null;
    }
}

// ── AUTHENTICATION ENDPOINTS ──────────────────────────────

app.post('/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required" });

        const db = mongoClient.db("foodi");
        const users = db.collection("users");

        const existing = await users.findOne({ email });
        if (existing) return res.status(400).json({ error: "User already exists" });

        const newUser = {
            email,
            password, // NOTE: In production, hash this password!
            name: name || email.split('@')[0],
            createdAt: new Date(),
            lastLogin: new Date(),
            isPremium: false
        };

        await users.insertOne(newUser);
        res.status(201).json({ message: "User registered successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const db = mongoClient.db("foodi");
        const users = db.collection("users");

        const user = await users.findOne({ email, password });
        if (!user) return res.status(401).json({ error: "Invalid credentials" });

        await users.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });

        res.json({
            message: "Login successful",
            token: "chef_aykut_token_" + user._id,
            user: { email: user.email, name: user.name, isPremium: user.isPremium }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/social-login', async (req, res) => {
    try {
        const { email, name, provider, uid } = req.body;
        if (!email) return res.status(400).json({ error: "Email required" });

        const db = mongoClient.db("foodi");
        const users = db.collection("users");

        let user = await users.findOne({ email });

        if (!user) {
            user = {
                email,
                name: name || email.split('@')[0],
                provider: provider || 'unknown',
                providerId: uid,
                createdAt: new Date(),
                lastLogin: new Date(),
                isPremium: false
            };
            await users.insertOne(user);
        } else {
            await users.updateOne({ _id: user._id }, { $set: { lastLogin: new Date(), providerId: uid } });
        }

        res.json({
            message: "Social login successful",
            token: "chef_aykut_token_" + user._id,
            user: { email: user.email, name: user.name, isPremium: user.isPremium }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



app.get('/recipes/count', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const category = req.query.category;
        
        let count;
        if (category) {
            count = await collection.countDocuments({ c: { $regex: '^' + category + '$', $options: 'i' } });
        } else {
            count = await collection.estimatedDocumentCount();
        }
        res.json({ count });
    } catch (err) {
        console.error(`❌ Error in /recipes/count:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes/counts', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const counts = await collection.aggregate([
            { $group: { _id: "$c", count: { $sum: 1 } } }
        ]).toArray();
        
        const result = {};
        counts.forEach(c => {
            if (c._id) result[c._id] = c.count;
        });
        res.json(result);
    } catch (err) {
        console.error(`❌ Error in /recipes/counts:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/home/previews', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        
        const categories = [
            'gastro', 'chef', 'main', 'soup', 'sauce', 'salad', 'appetizer', 
            'dessert', 'bread', 'breakfast', 'preserve', 'beverage', 'other'
        ];

        const results = {};
        
        // Parallel fetch for 1 sample recipe per category
        const promises = categories.map(async (cat) => {
            const query = getCategoryQuery(cat);
            const recipe = await collection.findOne(query, { sort: { r: -1 } });
            if (recipe) {
                results[cat] = _formatRecipe(recipe);
            }
        });

        await Promise.all(promises);
        res.json(results);
    } catch (err) {
        console.error(`❌ Error in /home/previews:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes/categories/:category/subs', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const category = req.params.category;

        let pipeline;
        if (category.toLowerCase() === 'main') {
            pipeline = [
                { $match: getCategoryQuery(category) },
                { $facet: {
                    subs: [ { $group: { _id: "$s" } } ],
                    cats: [ { $group: { _id: "$c" } } ]
                }},
                { $project: {
                    all: { $setUnion: ["$subs._id", "$cats._id"] }
                }}
            ];
            const [result] = await collection.aggregate(pipeline).toArray();
            let all = result.all.filter(s => s && s !== 'null');
            all = all.filter(s => !s.toLowerCase().includes('main dish'));
            res.json(all.sort());
        } else {
            pipeline = [
                { $match: getCategoryQuery(category) },
                { $group: { _id: "$s" } },
                { $match: { _id: { $ne: null } } },
                { $sort: { _id: 1 } },
                { $limit: 50 }
            ];
            const docs = await collection.aggregate(pipeline).toArray();
            const subs = docs.map(d => d._id).filter(s => s);
            res.json(subs);
        }
    } catch (err) {
        console.error(`❌ Server Error:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes', async (req, res) => {
    console.log(`📡 Incoming /recipes request: ${JSON.stringify(req.query)}`);
    try {
        let page = parseInt(req.query.page) || 0;
        let limit = parseInt(req.query.limit) || 20;
        
        if (page < 0) page = 0;
        if (limit <= 0) limit = 20;
        if (limit > 100) limit = 100;

        const category = req.query.category;
        const subcategory = req.query.subcategory;
        const query_text = req.query.q;

        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");

        // ── Gastro & Chef Pro: Doğrudan R2 chunk'tan serve et ──────────────────
        const cat = (category || '').toLowerCase();

        if (cat === 'gastro') {
            try {
                const gastroChunk = await getGastroRecipes();

                let filtered = gastroChunk;
                if (subcategory) {
                    const sub = subcategory.toLowerCase();
                    filtered = gastroChunk.filter(r => 
                        (r.s || r.subcategory || '').toLowerCase().includes(sub)
                    );
                }
                if (query_text) {
                    const q = query_text.toLowerCase();
                    filtered = filtered.filter(r =>
                        (r.t || r.title || '').toLowerCase().includes(q)
                    );
                }

                const start = page * limit;
                const slice = filtered.slice(start, start + limit);
                return res.json(slice.map(r => {
                    const imgRaw = r.p || r.img || r.image || '';
                    const imgUrl = _resolveImageUrl(imgRaw, 'gastro');
                    return {
                        i: r.i || r.id || r.uid || '',
                        t: r.t || r.title || '',
                        c: 'gastro',
                        h: 'gastro',
                        p: imgRaw,
                        r: r.r || r.rating || 0,
                        s: r.s || r.subcategory || '',
                        g: r.g || r.nb_servings || '',
                        l: r.l || r.total_time || r.prep_time || '',
                        m: r.m || r.ingredients || [],
                        y: r.y || r.steps || r.instructions || [],
                        id: r.i || r.id || r.uid || '',
                        title: r.t || r.title || '',
                        category: 'gastro',
                        img: imgUrl,
                        image: imgUrl,
                        imageUrl: imgUrl,
                    };
                }));
            } catch (gastroErr) {
                console.warn('⚠️ Gastro chunk serve failed:', gastroErr.message);
                return res.json([]);
            }
        }

        if (cat === 'chef' || cat === 'chef_pro' || cat.includes('chef')) {
            try {
                const chefChunk = await getChefRecipes();

                let filtered = chefChunk;
                if (subcategory) {
                    const sub = subcategory.toLowerCase();
                    filtered = chefChunk.filter(r => 
                        (r.s || r.subcategory || '').toLowerCase().includes(sub)
                    );
                }
                if (query_text) {
                    const q = query_text.toLowerCase();
                    filtered = filtered.filter(r =>
                        (r.t || r.title || '').toLowerCase().includes(q)
                    );
                }

                const start = page * limit;
                const slice = filtered.slice(start, start + limit);
                return res.json(slice.map(r => {
                    const imgRaw = r.p || r.img || r.image || '';
                    const imgUrl = _resolveImageUrl(imgRaw, 'chef');
                    return {
                        i: r.i || r.id || r.uid || '',
                        t: r.t || r.title || '',
                        c: 'chef_pro',
                        h: 'chef',
                        p: imgRaw,
                        r: r.r || r.rating || 0,
                        s: r.s || r.subcategory || '',
                        g: r.g || r.nb_servings || '',
                        l: r.l || r.total_time || r.prep_time || '',
                        m: r.m || r.ingredients || [],
                        y: r.y || r.steps || r.instructions || [],
                        id: r.i || r.id || r.uid || '',
                        title: r.t || r.title || '',
                        category: 'chef_pro',
                        img: imgUrl,
                        image: imgUrl,
                        imageUrl: imgUrl,
                    };
                }));
            } catch (chefErr) {
                console.warn('⚠️ Chef chunk serve failed:', chefErr.message);
                // Fallback to MongoDB
            }
        }

        if (query_text && query_text.length > 1) {
            try {
                const searchPipeline = [
                    {
                        $search: {
                            index: "default",
                            compound: {
                                must: [{
                                    text: {
                                        query: query_text,
                                        path: ["t", "name", "title"],
                                        fuzzy: { maxEdits: 1 }
                                    }
                                }],
                                should: [
                                    {
                                        near: {
                                            path: "r",
                                            origin: 5,
                                            pivot: 2,
                                            score: { boost: 2 }
                                        }
                                    },
                                    {
                                        exists: {
                                            path: "img",
                                            score: { boost: 1.5 }
                                        }
                                    }
                                ]
                            }
                        }
                    },
                    { $skip: page * limit },
                    { $limit: limit }
                ];
                
                if (category) {
                    const catQuery = getCategoryQuery(category);
                    if (catQuery.c && catQuery.c.$regex) {
                        searchPipeline[0].$search.compound.filter = [{
                            text: {
                                query: category,
                                path: "c"
                            }
                        }];
                    } else if (catQuery.h) {
                        searchPipeline[0].$search.compound.filter = [{
                            text: {
                                query: catQuery.h,
                                path: "h"
                            }
                        }];
                    }
                }

                const searchResults = await collection.aggregate(searchPipeline).toArray();
                return res.json(searchResults.map(r => _formatRecipe(r)));
            } catch (searchErr) {
                console.warn("⚠️ Atlas Search failed, falling back to Regex:", searchErr.message);
            }
        }

        let query = {};
        if (category) {
            Object.assign(query, getCategoryQuery(category));
        }
        if (subcategory) {
            const safeSub = subcategory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.$or = [{ s: { $regex: safeSub, $options: 'i' } }, { c: { $regex: '^' + safeSub + '$', $options: 'i' } }];
        }
        if (query_text) query.t = { $regex: '^' + query_text, $options: 'i' };

        const recipes = await collection.find(query)
            .sort({ r: -1 }) 
            .skip(page * limit)
            .limit(limit)
            .toArray();
            
        res.json(recipes.map(r => _formatRecipe(r)));
    } catch (err) {
        console.error(`❌ Server Error:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

function _formatRecipe(r, details = null) {
    const cat = (r.c || r.category || '').toLowerCase();
    const fallbackImages = {
        'dessert':   'https://images.unsplash.com/photo-1551024506-0bccd828d307?q=80&w=500',
        'soup':      'https://images.unsplash.com/photo-1547592166-23ac45744acd?q=80&w=500',
        'salad':     'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=500',
        'beef':      'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=500',
        'chicken':   'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?q=80&w=500',
        'breakfast': 'https://images.unsplash.com/photo-1482049016688-2d3e1b311543?q=80&w=500',
        'pasta':     'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?q=80&w=500',
        'default':   'https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=500'
    };

    // Logic: Try DB first, then R2 details
    const tryKeys = ['img', 'image', 'imageUrl', 'image_url', 'resim', 'photo', 'pic', 'gorsel', 'resim_url', 'photo_url'];
    
    let dbImg = null;
    for (const key of tryKeys) {
        if (r[key] && typeof r[key] === 'string' && r[key].length > 5) {
            dbImg = r[key];
            break;
        }
    }
    if (!dbImg && typeof r.p === 'string' && r.p.startsWith('http')) dbImg = r.p;
    
    let r2Img = null;
    if (details) {
        for (const key of tryKeys) {
            if (details[key] && typeof details[key] === 'string' && details[key].length > 5) {
                r2Img = details[key];
                break;
            }
        }
        if (!r2Img && typeof details.p === 'string' && details.p.startsWith('http')) r2Img = details.p;
    }
    
    const isValid = (url) => {
        if (!url || typeof url !== 'string' || url.length < 10) return false;
        if (!url.startsWith('http')) return false;
        // Known domains that block hotlinking or are unreliable
        const forbiddenDomains = ['food.fnr.sndimg.com', 'sndimg.com', 'placeholder.com'];
        if (forbiddenDomains.some(domain => url.includes(domain))) return false;
        return true;
    };

    const id = r.i || r.id || r.uid || (r._id ? r._id.toString() : '');

    let img = '';
    if (isValid(r2Img)) {
        img = r2Img; // R2 details (hydration) takes priority for Gastro/Chef
    } else if (isValid(dbImg)) {
        img = dbImg;
    }

    if (!img) {
        // Final Fallback: Construct Proxy Image URL based on ID
        img = `https://chef-aykut-backend.onrender.com/images/${id}.webp`;
        console.log(`🔗 CONSTRUCTED_PROXY_IMAGE for recipe: ${r.t || r.name} -> ${img}`);
    } else {
        img = _resolveImageUrl(img, cat);
        console.log(`✅ IMAGE_RESOLVED for recipe: ${r.t || r.name} -> ${img.substring(0, 45)}...`);
    }

    const chunk = r.h !== undefined ? r.h : (r.chunk !== undefined ? r.chunk : null);
    
    // If r.p is a URL, don't overwrite it with chunk ID here; use a separate part variable
    const part = (typeof r.p === 'number') ? r.p : chunk;

    return {
        i: id,
        t: r.t || r.title || r.name || 'Untitled Recipe',
        c: r.c || r.category || r.main_category || 'General',
        s: r.s || r.subcategory || r.sub_category || '',
        h: chunk,
        p: part, 
        o: r.o,
        l: r.l,
        r: r.r || r.rating || 0,
        img: img,
        image: img,
        imageUrl: img,
        image_url: img,
        // Detailed data
        m: (details && (details.m || details.ingredients || details.malzemeler || details.icindekiler || details.components)) || r.m || r.ingredients || r.malzemeler || r.icindekiler || [],
        y: (details && (details.y || details.steps || details.instructions || details.yapilis || details.hazirlanisi || details.cooking_steps)) || r.y || r.steps || r.instructions || r.yapilis || [],
        g: r.g || r.nb_servings || r.servings || '',
        l_time: r.l || r.prep_time || r.total_time || '',
        // Legacy support
        id: id,
        title: r.t || r.title || r.name || 'Untitled Recipe',
        category: r.c || r.category || r.main_category || 'General'
    };
}

app.get('/daily', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const count = await collection.estimatedDocumentCount();
        const limit = 20;
        
        const today = new Date();
        const seedStr = `${today.getUTCFullYear()}-${today.getUTCMonth()}-${today.getUTCDate()}`;
        
        let hash = 0;
        for (let i = 0; i < seedStr.length; i++) {
            hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
            hash |= 0; 
        }
        hash = Math.abs(hash);
        
        const offset = hash % (count > limit ? count - limit : 1);
        const recipes = await collection.find({}).skip(offset).limit(limit).toArray();
            
        res.json(recipes.map(r => _formatRecipe(r)));
    } catch (err) {
        console.error(`❌ Server Error in /daily:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/recipes/:id(*)', async (req, res) => {
    try {
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const targetId = req.params.id;
        
        console.log(`🔍 API Request for ID: ${targetId}`);
        
        let recipe = await collection.findOne({ _id: targetId });
        if (!recipe) {
            recipe = await collection.findOne({ i: targetId });
        }

        if (!recipe && targetId.length === 24) {
            try {
                recipe = await collection.findOne({ _id: new ObjectId(targetId) });
            } catch (e) {}
        }

        if (!recipe) {
            console.log(`❌ Recipe not found in MongoDB: ${targetId}. Trying memory chunks fallback...`);
            // Try to find it directly in Gastro and Chef chunks
            const gastroChunk = await getGastroRecipes();
            let foundInChunk = gastroChunk.find(r => {
                const rid = (r.i || r.id || r.uid || r.url || '').toString();
                return rid === targetId || normalizeTitle(r.t || r.title || '') === normalizeTitle(targetId);
            });
            if (!foundInChunk) {
                const chefChunk = await getChefRecipes();
                foundInChunk = chefChunk.find(r => {
                    const rid = (r.i || r.id || r.uid || r.url || '').toString();
                    return rid === targetId || normalizeTitle(r.t || r.title || '') === normalizeTitle(targetId);
                });
            }
            
            if (foundInChunk) {
                console.log(`✅ Found recipe in chunk fallback: ${foundInChunk.t || foundInChunk.title || 'Untitled'}`);
                return res.json(_formatRecipe(foundInChunk, foundInChunk));
            }
            
            return res.status(404).json({ error: "Recipe not found in database or chunks", id: targetId });
        }

        console.log(`✅ Found in Mongo: ${recipe.t} (ID: ${recipe.i}, h: ${recipe.h}, _id: ${recipe._id})`);

        // HYDRATION LOGIC: Merge data from external chunks (Chef/Gastro datasets)
        let details = null;
        let effectiveH = recipe.h;

        // Force hydration for specific categories if 'h' is missing
        if (!effectiveH) {
            const category = (recipe.c || recipe.category || '').toLowerCase();
            if (category.includes('gastro') || category.includes('legacy_sauce')) {
                effectiveH = 'gastro';
            } else if (category.includes('chef') || category.includes('pro')) {
                effectiveH = 'chef';
            }
        }

        if (effectiveH !== undefined && effectiveH !== null) {
            console.log(`📡 Attempting hydration for ${recipe.i || recipe._id} (h: ${effectiveH})`);
            details = await getRecipeFromChunk(
                effectiveH, 
                recipe.i || recipe._id, 
                recipe.t || recipe.title || recipe.name
            );
            
            if (details) {
                console.log(`✅ Hydration SUCCESS for ${recipe.i || recipe._id} from chunk ${effectiveH}`);
            } else {
                console.warn(`⚠️ Hydration FAILED for ${recipe.i || recipe._id} from chunk ${effectiveH}`);
            }
        }
    
        // 🔄 FALLBACK: If primary chunk fails, try Chef and Gastro
        if (!details && recipe.h !== 'chef' && recipe.h !== 'gastro') {
            console.log(`🔍 Fallback: Trying 'chef' chunk...`);
            details = await getRecipeFromChunk('chef', recipe.i || recipe._id, recipe.t || recipe.title);
            if (!details) {
                console.log(`🔍 Fallback: Trying 'gastro' chunk...`);
                details = await getRecipeFromChunk('gastro', recipe.i || recipe._id, recipe.t || recipe.title);
            }
        }
            
        if (details) {
            console.log(`✨ Successfully hydrated from R2!`);
            return res.json(_formatRecipe(recipe, details));
        } else {
            console.warn(`⚠️ Hydration failed for ${recipe.i || recipe._id}, sending basic info`);
            return res.json(_formatRecipe(recipe));
        }
    } catch (err) {
        console.error(`🔥 Server Error:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.patch('/recipes/:id/image', async (req, res) => {
    try {
        const { id } = req.params;
        const { image } = req.body;

        if (!image || !image.startsWith('http')) {
            return res.status(400).json({ error: "Valid image URL required" });
        }

        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");

        let result = await collection.updateOne(
            { _id: id },
            { $set: { img: image, image: image, p: image } }
        );

        if (result.matchedCount === 0) {
            result = await collection.updateOne(
                { i: id },
                { $set: { img: image, image: image, p: image } }
            );
        }

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        console.log(`✅ Image updated for recipe ${id}`);
        res.json({ success: true, message: "Image updated successfully" });
    } catch (err) {
        console.error(`❌ Error updating image:`, err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/gastro_images/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        
        // If a direct Cloudflare CDN base is configured, redirect there instantly (no proxy overhead)
        if (GASTRO_CDN_BASE) {
            return res.redirect(302, `${GASTRO_CDN_BASE}/gastro_images/${filename}`);
        }

        const key = `gastro_images/${filename}`;
        
        // Get a pre-signed or public URL from R2 and redirect — much faster than proxying binary
        // Try to generate a redirect URL using the R2 public endpoint
        const r2PublicBase = process.env.R2_PUBLIC_BASE || '';
        if (r2PublicBase) {
            return res.redirect(302, `${r2PublicBase}/${key}`);
        }

        // Fallback: proxy the binary (slow but works)
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        
        const response = await s3Client.send(command);
        const byteArray = await response.Body.transformToByteArray();
        
        res.setHeader('Content-Type', response.ContentType || 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.send(Buffer.from(byteArray));
    } catch (err) {
        console.error(`❌ Error proxying gastro image ${req.params.filename}:`, err.message);
        res.status(404).send("Image not found");
    }
});

app.get('/images/:filename(*)', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `images/${filename}`;
        
        // 1. Try to get it from R2 first (e.g. Gastro images or already cached images)
        try {
            const command = new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key
            });
            const response = await s3Client.send(command);
            const byteArray = await response.Body.transformToByteArray();
            res.setHeader('Content-Type', response.ContentType || 'image/webp');
            res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
            return res.send(Buffer.from(byteArray));
        } catch (r2err) {
            // Not found in R2, proceed to resolve original external URL
        }

        // 2. Extract recipe ID from filename (e.g. "uuid.webp" or URL slug)
        const id = filename.replace('.webp', '');
        
        // 3. Find recipe in MongoDB Atlas to get chunk ID 'h' and title 't'
        const db = mongoClient.db("foodi");
        const collection = db.collection("chefaykut");
        const recipe = await collection.findOne({ _id: id });
        
        if (recipe && recipe.h !== undefined && recipe.h !== null) {
            // 4. Fetch full recipe from chunk to get the original image URL 'p'
            const details = await getRecipeFromChunk(recipe.h, id, recipe.t);
            if (details && details.p && typeof details.p === 'string' && details.p.startsWith('http')) {
                console.log(`✈️ Redirecting to external image: ${details.p}`);
                return res.redirect(details.p);
            }
        }
        
        res.status(404).send("Image not found");
    } catch (err) {
        console.error(`❌ Error serving proxy image:`, err.message);
        res.status(404).send("Image not found");
    }
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await mongoClient.connect();
    console.log(`🚀 Server ready on port ${PORT}`);
    
    // Self-ping mechanism to stay awake on Cloud (Render, etc.)
    const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
        const http = require('http');
        const https = require('https');
        const client = EXTERNAL_URL.startsWith('https') ? https : http;
        
        client.get(`${EXTERNAL_URL}/ping`, (res) => {
            console.log(`📡 Self-ping successful: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`❌ Self-ping failed: ${err.message}`);
        });
    }, 10 * 60 * 1000); // Every 10 minutes
});
