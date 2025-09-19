const express = require('express');
const puppeteer = require('puppeteer');
const os = require('os');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
// Config
const CONFIG = {
    PORT: Number(process.env.PORT || 6785),
    UPDATE_INTERVAL_MS: 30 * 60 * 1000, // 30 dakika sabit
    LOGIN_URL: process.env.LOGIN_URL || 'https://uygulama.parasut.com/kullanici-girisi',
    LOGIN_EMAIL: process.env.LOGIN_EMAIL || process.env.EMAIL || null,
    LOGIN_PASSWORD: process.env.LOGIN_PASSWORD || process.env.PASSWORD || null,
    HEADLESS: process.env.HEADLESS === 'false' ? false : true,
    API_KEY: process.env.API_KEY || null,
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || null,
};
const PORT = CONFIG.PORT;

// Global değişkenler
let currentBearerToken = null;
let lastUpdated = null;
let isRunning = false;
let intervalId = null;
let updateInProgress = false; // prevent overlapping refreshes
let lastError = null;

// Platform-specific Puppeteer ayarları
function getPuppeteerOptions() {
    const isWindows = os.platform() === 'win32';
    const isLinux = os.platform() === 'linux';
    
    let options = {
    headless: CONFIG.HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080'
        ]
    };
    if (CONFIG.PUPPETEER_EXECUTABLE_PATH) {
        options.executablePath = CONFIG.PUPPETEER_EXECUTABLE_PATH;
    }

    if (isLinux) {
        options.args.push('--disable-extensions');
        options.args.push('--no-first-run');
        options.args.push('--disable-default-apps');
    }

    if (isWindows) {
        options.args.push('--disable-features=VizDisplayCompositor');
    }

    return options;
}

// Bearer token almak için Puppeteer kullanarak giriş yapma fonksiyonu
// Bearer token alma fonksiyonu
async function getBearerToken() {
    if (!CONFIG.LOGIN_EMAIL || !CONFIG.LOGIN_PASSWORD) {
        throw new Error('Giriş bilgileri eksik: .env içinde LOGIN_EMAIL ve LOGIN_PASSWORD tanımlayın');
    }
    let browser = null;
    try {
        console.log('🚀 Tarayıcı başlatılıyor...');
        browser = await puppeteer.launch(getPuppeteerOptions());

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(30000);
        
        // User agent ayarla
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        // Viewport ayarla
        await page.setViewport({ width: 1920, height: 1080 });
        
        console.log('🌐 Parasut giriş sayfasına gidiliyor...');
        await page.goto(CONFIG.LOGIN_URL, {
            waitUntil: 'networkidle2', // Use networkidle2 instead of networkidle0
            timeout: 30000
        });

        // E-posta alanını doldur
        console.log('✉️ E-posta adresi giriliyor...');
        await page.waitForSelector('input[name="user[email]"]', { timeout: 10000 });
        await page.$eval('input[name="user[email]"]', (input) => (input.value = ''));
    await page.type('input[name="user[email]"]', CONFIG.LOGIN_EMAIL);

        // Devam et butonuna tıkla
        console.log('➡️ Devam Et butonuna tıklanıyor...');
        await page.click('#continue-btn');

        // Şifre sayfasına yönlendirilmesini bekle
        console.log('🔐 Şifre sayfası bekleniyor...');
        await page.waitForSelector('#password', { timeout: 10000 });
        
        // Şifreyi gir
        console.log('🔑 Şifre giriliyor...');
        await page.$eval('#password', (input) => (input.value = ''));
    await page.type('#password', CONFIG.LOGIN_PASSWORD);

        // Network isteklerini dinle (Bearer token'i yakalamak için)
        const bearerTokenPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Bearer token bulunamadı (timeout)'));
            }, 30000);

            const done = (val) => { try { clearTimeout(timeout); resolve(val); } catch {} };

            const onResponse = async (response) => {
                try {
                    const authHeader = response.headers()['authorization'];
                    if (authHeader && authHeader.startsWith('Bearer ')) {
                        page.off('response', onResponse);
                        page.off('request', onRequest);
                        done(authHeader);
                        return;
                    }
                } catch (error) {
                    // Hata durumunda devam et
                }
            };

            const onRequest = (request) => {
                try {
                    const authHeader = request.headers()['authorization'];
                    if (authHeader && authHeader.startsWith('Bearer ')) {
                        page.off('response', onResponse);
                        page.off('request', onRequest);
                        done(authHeader);
                        return;
                    }
                } catch (error) {
                    // Hata durumunda devam et
                }
            };

            page.on('response', onResponse);
            page.on('request', onRequest);
        });

        // Giriş butonuna tıkla ve aynı anda navigasyonu bekle
        console.log('🚪 Giriş Yap butonuna tıklanıyor...');
        const [_, token] = await Promise.all([
            page.click('#kc-login').catch((err) => console.error('Click error:', err.message)),
            bearerTokenPromise,
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch((err) => {
                console.warn('⚠️ Navigation timeout, but continuing to check for token:', err.message);
            })
        ]);

        // Bearer token'i al
        console.log('🎯 Bearer token bekleniyor...');
    const bearerToken = token || await bearerTokenPromise;

        // Girişin başarılı olduğunu doğrula
        const isLoggedIn = await page.$('body').then(res => !!res);
        if (!isLoggedIn) {
            throw new Error('Giriş başarısız, sayfa yüklenemedi');
        }

        console.log('✅ Bearer token başarıyla alındı!');
        return bearerToken;

    } catch (error) {
        console.error('❌ Bearer token alma hatası:', error.message);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
            console.log('🧹 Tarayıcı kapatıldı');
        }
    }
}

// Token'i güncelle
async function updateToken() {
    if (!isRunning) return;
    if (updateInProgress) {
        console.log('⏭️ Güncelleme zaten devam ediyor, atlanıyor...');
        return;
    }
    updateInProgress = true;
    
    try {
        console.log('\n=== 🔄 Token güncelleniyor ===');

        const maxAttempts = Number(process.env.UPDATE_RETRY_MAX || 3);
        const baseDelay = Number(process.env.UPDATE_RETRY_DELAY_MS || 5000);
        let token = null;
        let attempt = 0;
        lastError = null;

        while (attempt < maxAttempts && !token) {
            attempt++;
            try {
                token = await getBearerToken();
            } catch (err) {
                lastError = err;
                const delay = baseDelay * attempt;
                console.warn(`⚠️ Deneme ${attempt}/${maxAttempts} başarısız: ${err.message}. ${delay}ms sonra tekrar denenecek...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        if (!token) throw lastError || new Error('Token alınamadı');
        
        currentBearerToken = token;
        lastUpdated = new Date();
        const preview = `${token.slice(0, 12)}...${token.slice(-6)}`;
        console.log(`✅ Token başarıyla güncellendi: ${new Date().toLocaleString('tr-TR')}`);
        console.log(`🔍 Token preview: ${preview}`);
    } catch (error) {
        console.error('❌ Token güncelleme hatası:', error.message);
        lastError = error;
    }
    finally {
        updateInProgress = false;
    }
}

// Otomatik güncellemeyi başlat
function startAutoUpdate() {
    if (isRunning) return;
    
    if (!CONFIG.LOGIN_EMAIL || !CONFIG.LOGIN_PASSWORD) {
        console.warn('⚠️ LOGIN_EMAIL veya LOGIN_PASSWORD tanımlı değil. Otomatik güncelleme başlatılmadı. .env dosyasını doldurun.');
        return;
    }

    isRunning = true;
    console.log('▶️ Otomatik güncelleme başlatıldı');
    
    // İlk token'i hemen al
    updateToken();
    
    // Belirlenen aralıkta token'i güncelle
    intervalId = setInterval(updateToken, CONFIG.UPDATE_INTERVAL_MS);
}

// Otomatik güncellemeyi durdur
function stopAutoUpdate() {
    if (!isRunning) return;
    
    isRunning = false;
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    console.log('⏹️ Otomatik güncelleme durduruldu');
}

// Bir sonraki güncellemeye kalan süre
function getTimeToNextUpdate() {
    if (!isRunning || !lastUpdated) {
        return null;
    }
    
    const nextUpdate = new Date(lastUpdated.getTime() + CONFIG.UPDATE_INTERVAL_MS);
    const now = new Date();
    const timeLeft = nextUpdate.getTime() - now.getTime();
    
    if (timeLeft <= 0) return 0;
    
    const minutes = Math.floor(timeLeft / (1000 * 60));
    const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
    
    return {
        totalMs: timeLeft,
        minutes: minutes,
        seconds: seconds,
        formatted: `${minutes}:${seconds.toString().padStart(2, '0')}`
    };
}

// API Endpoints

// Basit API key doğrulama (opsiyonel)
function requireApiKey(req, res, next) {
    if (!CONFIG.API_KEY) return next();
    const provided = req.get('x-api-key') || req.query.api_key;
    if (provided === CONFIG.API_KEY) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// Güncel Bearer token
app.get('/api/bearer', requireApiKey, (req, res) => {
    if (!currentBearerToken) {
        return res.status(404).json({
            error: 'Bearer token henüz alınmadı',
            lastUpdated: lastUpdated,
            isRunning: isRunning
        });
    }

    res.json({
        bearerToken: currentBearerToken,
        lastUpdated: lastUpdated,
        isRunning: isRunning,
        timeToNext: getTimeToNextUpdate()
    });
});

// Yenilenmeye kalan süre
app.get('/api/time', requireApiKey, (req, res) => {
    const timeLeft = getTimeToNextUpdate();
    
    res.json({
        isRunning: isRunning,
        lastUpdated: lastUpdated,
        timeToNextUpdate: timeLeft,
        nextUpdateTime: lastUpdated ? new Date(lastUpdated.getTime() + CONFIG.UPDATE_INTERVAL_MS) : null,
        intervalMs: CONFIG.UPDATE_INTERVAL_MS
    });
});

// Eski Bearer tokenler
app.get('/api/old-bearer', requireApiKey, (req, res) => {
    // Database kaldırıldı, sadece mevcut token'i döndür
    res.json({
        oldTokens: [],
        totalOldTokens: 0,
        currentToken: currentBearerToken ? {
            preview: `${currentBearerToken.slice(0, 12)}...${currentBearerToken.slice(-6)}`,
            createdAt: lastUpdated
        } : null
    });
});

// Recent errors
app.get('/api/errors', requireApiKey, (req, res) => {
    // Database kaldırıldı, sadece son hatayı döndür
    res.json({ 
        errors: lastError ? [{ 
            error: lastError.message, 
            created_at: new Date().toISOString() 
        }] : [] 
    });
});

// Interval settings
app.get('/api/interval', requireApiKey, (req, res) => {
    res.json({ intervalMs: CONFIG.UPDATE_INTERVAL_MS, intervalMinutes: Math.round(CONFIG.UPDATE_INTERVAL_MS / 60000) });
});

app.post('/api/interval', requireApiKey, async (req, res) => {
    // Interval artık sabit 30 dakika olduğu için değiştirilemez
    res.status(400).json({ error: 'Interval artık sabit 30 dakika olarak ayarlanmıştır ve değiştirilemez' });
});

// Manuel token alma işlemini başlat
app.post('/api/start', requireApiKey, async (req, res) => {
    if (isRunning) {
        return res.json({
            message: 'Otomatik güncelleme zaten çalışıyor',
            isRunning: true
        });
    }
    
    startAutoUpdate();
    
    res.json({
        message: 'Otomatik güncelleme başlatıldı',
        isRunning: true,
        startedAt: new Date()
    });
});

// İşlemleri durdur
app.post('/api/stop', requireApiKey, (req, res) => {
    if (!isRunning) {
        return res.json({
            message: 'Otomatik güncelleme zaten durmuş durumda',
            isRunning: false
        });
    }
    
    stopAutoUpdate();
    
    res.json({
        message: 'Otomatik güncelleme durduruldu',
        isRunning: false,
        stoppedAt: new Date()
    });
});

// Sistem durumu
app.get('/api/status', requireApiKey, (req, res) => {
    res.json({
        status: 'running',
        isAutoUpdateRunning: isRunning,
        hasToken: !!currentBearerToken,
        lastUpdated: lastUpdated,
        nextUpdate: getTimeToNextUpdate(),
        totalOldTokens: 0,
        uptime: process.uptime(),
        platform: os.platform(),
        nodeVersion: process.version,
        lastError: lastError ? lastError.message : null,
        intervalMs: CONFIG.UPDATE_INTERVAL_MS
    });
});

// Health check (no auth)
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Web Arayüzü (static file)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Sunucuyu başlat
const server = app.listen(PORT, async () => {
    console.log(`🚀 Parasut Token Service başlatıldı!`);
    console.log(`📡 API Sunucusu: http://localhost:${PORT}`);
    console.log(`🌐 Web Arayüzü: http://localhost:${PORT}`);
    console.log(`💻 Platform: ${os.platform()} ${os.arch()}`);
    console.log(`📊 Node.js: ${process.version}`);
    const mins = Math.round(CONFIG.UPDATE_INTERVAL_MS / 60000);
    console.log(`⏰ Token güncelleme aralığı: ${mins} dakika (sabit)\n`);
    
    // Başlangıçta otomatik güncellemeyi başlat (kimlik bilgileri varsa)
    startAutoUpdate();
});

// Server timeouts for long-lived stability
server.keepAliveTimeout = 65000; // 65s to play nice with proxies
server.headersTimeout = 66000;

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Sunucu kapatılıyor...');
    stopAutoUpdate();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Sunucu kapatılıyor...');
    stopAutoUpdate();
    process.exit(0);
});

// Global error guards to keep process alive
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err);
});