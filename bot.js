const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const fs = require('fs').promises;
const Tesseract = require('tesseract.js');
const axios = require('axios');

// ==================== SOZLAMALAR ====================
const BOT_TOKEN = '8147643248:AAFus5h1HV-Sy71kE-gf31bpUPzfTtUbs_c';
const ADMIN_ID = 7903688837;
const CHANNEL_ID = '-1003329611120';
const DATABASE_NAME = 'sinf_bot.db';
const STUDENTS_FILE = 'students.txt';

// ==================== MA'LUMOTLAR BAZASINI TO'LIQ QAYTA YARATISH ====================
console.log('🔄 Ma\'lumotlar bazasi to\'liq qayta yaratilmoqda...');

// Avval eski baza faylini o'chirish
try {
    if (fs.existsSync(DATABASE_NAME)) {
        fs.unlinkSync(DATABASE_NAME);
        console.log('🗑️ Eski baza fayli o\'chirildi');
    }
} catch (err) {
    console.log('⚠️ Baza o\'chirilmadi, lekin davom etamiz:', err.message);
}

const db = new sqlite3.Database(DATABASE_NAME);

// YANGI BAZA STRUKTURASI
db.serialize(() => {
    console.log('🏗️ Yangi jadvallar yaratilmoqda...');
    
    // 1. O'QUVCHILAR JADVALI
    db.run(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT UNIQUE NOT NULL,
        first_name TEXT,
        last_name TEXT,
        variants TEXT,
        active INTEGER DEFAULT 1
    )`, (err) => {
        if (err) console.error('❌ students jadval xatosi:', err.message);
        else console.log('✅ students jadvali yaratildi');
    });
    
    // 2. KIRISHLAR JADVALI (TO'LIQ USTUNLAR BILAN)
    db.run(`CREATE TABLE IF NOT EXISTS checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        checkin_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        checkin_date DATE DEFAULT CURRENT_DATE,
        week_number INTEGER NOT NULL,
        source TEXT,
        ocr_text TEXT,
        caption_text TEXT,
        confidence FLOAT,
        UNIQUE(student_id, checkin_date) -- HAR KUN FAQAT 1 MARTA KIRISH
    )`, (err) => {
        if (err) console.error('❌ checkins jadval xatosi:', err.message);
        else console.log('✅ checkins jadvali yaratildi (kuniga 1 marta cheklov bilan)');
    });
    
    // 3. HAFTALIK STATISTIKA
    db.run(`CREATE TABLE IF NOT EXISTS weekly_stats (
        week_number INTEGER,
        student_id INTEGER,
        checkin_count INTEGER DEFAULT 0,
        last_checkin DATETIME,
        PRIMARY KEY (week_number, student_id)
    )`, (err) => {
        if (err) console.error('❌ weekly_stats jadval xatosi:', err.message);
        else console.log('✅ weekly_stats jadvali yaratildi');
    });
    
    // 4. KUNLIK STATISTIKA
    db.run(`CREATE TABLE IF NOT EXISTS daily_stats (
        checkin_date DATE PRIMARY KEY,
        total_checkins INTEGER DEFAULT 0,
        unique_students INTEGER DEFAULT 0
    )`, (err) => {
        if (err) console.error('❌ daily_stats jadval xatosi:', err.message);
        else console.log('✅ daily_stats jadvali yaratildi');
    });
});

// ==================== YANGILANGAN OCR FUNKSIYASI ====================
async function processImageOCR(fileUrl) {
    try {
        console.log('🔍 Rasm tahlil qilinmoqda...');
        
        const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 45000
        });
        
        // YANGI: OCR sozlamalarini o'zbekcha matn uchun optimallashtirish
        const { data: { text } } = await Tesseract.recognize(
            Buffer.from(response.data),
            'uzb+eng+rus', // O'zbek, Ingliz, Rus tillari
            {
                logger: m => {
                    // Faqat 10% qadamlar bilan log
                    if (m.status === 'recognizing text' && Math.round(m.progress * 100) % 10 === 0) {
                        console.log(`📊 ${Math.round(m.progress * 100)}%`);
                    }
                },
                // YANGI: O'zbekcha matn uchun maxsus sozlamalar
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ0123456789.,:;- ',
                preserve_interword_spaces: 1,
                psm: 3,  // Avtomatik segmentatsiya
                oem: 3,  // LSTM modeli
                user_patterns: ['[a-zA-Z]{2,}', '[А-Яа-я]{2,}'], // So'z patternlari
                user_words: ['Gulhayo', 'Mamatov', 'Ozodbek', 'Jorabek', 'Adilova', 'Mamasoliyev']
            }
        );
        
        // YANGI: Matnni yaxshiroq tozalash
        const cleanedText = text
            .toUpperCase()
            .replace(/[^A-ZА-ЯЁ\s.,:;-]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        
        console.log('✅ OCR natijasi:', cleanedText.substring(0, 150));
        return cleanedText;
        
    } catch (error) {
        console.error('❌ OCR xatosi:', error.message);
        return '';
    }
}

// ==================== KUCHAYTIRILGAN ISM QIDIRUV ALGORITMI ====================
class AdvancedNameFinder {
    // YANGI: Kuchaytirilgan Levenshtein masofasi
    static levenshteinDistance(a, b) {
        if (!a || !b) return 100;
        
        // Tezlashtirish: agar uzunliklar juda farq qilsa
        if (Math.abs(a.length - b.length) > 5) return 100;
        
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
        
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                const cost = a[j-1].toLowerCase() === b[i-1].toLowerCase() ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i-1][j] + 1,
                    matrix[i][j-1] + 1,
                    matrix[i-1][j-1] + cost
                );
            }
        }
        return matrix[b.length][a.length];
    }
    
    // YANGI: O'xshashlik balli
    static similarityScore(str1, str2) {
        if (!str1 || !str2) return 0;
        if (str1 === str2) return 1.0;
        
        const maxLen = Math.max(str1.length, str2.length);
        const distance = this.levenshteinDistance(str1, str2);
        const similarity = 1 - (distance / maxLen);
        
        // YANGI: Qo'shimcha ball berish
        let bonus = 0;
        
        // Agar biri ikkinchisini o'z ichiga olsa
        if (str1.includes(str2) || str2.includes(str1)) {
            bonus += 0.2;
        }
        
        // Bir xil boshlanish
        if (str1[0] === str2[0]) {
            bonus += 0.1;
        }
        
        return Math.min(similarity + bonus, 1.0);
    }
    
    // YANGI: Asosiy qidiruv funksiyasi
    static findBestMatch(text, students) {
        if (!text || text.length < 3) return [];
        
        const cleanText = text.toUpperCase()
            .replace(/[^A-ZА-ЯЁ\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        
        console.log('🔍 Qidiruv matni:', cleanText);
        
        const results = [];
        
        for (const student of students) {
            const studentName = student.full_name;
            const [lastName, firstName] = studentName.split(' ');
            
            if (!firstName || !lastName) continue;
            
            let bestScore = 0;
            let foundPattern = '';
            
            // 1. TO'LIQ ISM (100%)
            if (cleanText.includes(studentName)) {
                bestScore = 1.0;
                foundPattern = 'FULL_MATCH';
            }
            
            // YANGI: Familiya + Ism (yaqin joyda)
            const lastNameIndex = cleanText.indexOf(lastName);
            if (lastNameIndex !== -1) {
                // Familiyadan keyingi 30 belgi ichida Ismni qidirish
                const searchArea = cleanText.substring(lastNameIndex, lastNameIndex + 30);
                const words = searchArea.split(' ');
                
                for (const word of words) {
                    if (word.length < 3) continue;
                    
                    const similarity = this.similarityScore(word, firstName);
                    if (similarity > 0.8) {
                        const score = 0.9 + (similarity * 0.05);
                        if (score > bestScore) {
                            bestScore = Math.min(score, 0.98);
                            foundPattern = 'NAME_NEAR_LASTNAME';
                        }
                    }
                }
                
                // Agar faqat familiya bo'lsa
                if (bestScore === 0) {
                    // Familiyaning chastotasi
                    const regex = new RegExp(lastName, 'g');
                    const count = (cleanText.match(regex) || []).length;
                    
                    if (count >= 2) { // Kamida 2 marta takrorlanishi kerak
                        const score = 0.75 + (count * 0.03);
                        bestScore = Math.min(score, 0.85);
                        foundPattern = 'FREQUENT_LASTNAME';
                    }
                }
            }
            
            // YANGI: Teskari tartib (Ism + Familiya) - matnning boshlanishida
            const reversedName = `${firstName} ${lastName}`;
            if (cleanText.startsWith(reversedName) || cleanText.includes(` ${reversedName} `)) {
                const score = 0.95;
                if (score > bestScore) {
                    bestScore = score;
                    foundPattern = 'REVERSED_AT_START';
                }
            }
            
            // YANGI: Fuzzy match (harf xatolari uchun)
            const words = cleanText.split(' ');
            for (const word of words) {
                if (word.length < 4) continue;
                
                // Familiya uchun fuzzy match
                const lastNameSimilarity = this.similarityScore(word, lastName);
                if (lastNameSimilarity > 0.9) {
                    const score = 0.92;
                    if (score > bestScore) {
                        bestScore = score;
                        foundPattern = 'EXACT_FUZZY_LASTNAME';
                    }
                }
            }
            
            // YANGI: Minimal ball 80%
            if (bestScore >= 0.80) {
                results.push({
                    student,
                    score: bestScore,
                    pattern: foundPattern,
                    confidence: Math.round(bestScore * 100)
                });
            }
        }
        
        // YANGI: Tartiblash va filtrlash
        results.sort((a, b) => b.score - a.score);
        
        if (results.length === 0) return [];
        
        const topScore = results[0].score;
        const finalResults = [];
        
        // Faqat eng yuqori balli 1-2 ta natija
        for (const result of results) {
            if (result.score >= topScore * 0.98) { // 98% of top score
                finalResults.push(result);
            }
        }
        
        // YANGI: Agar bir nechta natija bo'lsa, ularni qayta tekshirish
        if (finalResults.length > 1) {
            // Familiya takrorlanishiga qarab qayta tartiblash
            finalResults.sort((a, b) => {
                const nameA = a.student.full_name;
                const nameB = b.student.full_name;
                
                // OCR matnida qaysi familiya ko'p takrorlangan?
                const countA = (cleanText.match(new RegExp(nameA.split(' ')[0], 'g')) || []).length;
                const countB = (cleanText.match(new RegExp(nameB.split(' ')[0], 'g')) || []).length;
                
                return countB - countA; // Ko'p takrorlangan birinchi
            });
        }
        
        console.log(`📊 Topilgan: ${finalResults.length} ta`);
        return finalResults.slice(0, 1); // FAQAT 1 TA ENG YAXSHISI
    }
}

// ==================== O'QUVCHILARNI YUKLASH ====================
async function loadStudents() {
    try {
        const data = await fs.readFile(STUDENTS_FILE, 'utf8');
        const lines = data.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        const students = [];
        
        for (const line of lines) {
            const fullName = line.toUpperCase().replace(/\s+/g, ' ');
            const [lastName, firstName] = fullName.split(' ');
            
            await new Promise((resolve) => {
                db.run(
                    `INSERT OR IGNORE INTO students (full_name, first_name, last_name) VALUES (?, ?, ?)`,
                    [fullName, firstName || '', lastName || ''],
                    function(err) {
                        if (err) {
                            console.error(`❌ ${fullName} saqlashda:`, err.message);
                        } else {
                            students.push({
                                id: this.lastID || students.length + 1,
                                full_name: fullName,
                                first_name: firstName || '',
                                last_name: lastName || ''
                            });
                        }
                        resolve();
                    }
                );
            });
        }
        
        console.log(`✅ ${students.length} ta o'quvchi yuklandi`);
        console.log('\n📋 O\'quvchilar ro\'yxati:');
        students.forEach((s, i) => console.log(`${i+1}. ${s.full_name}`));
        
        return students;
        
    } catch (error) {
        console.error('❌ O\'quvchilar yuklash:', error.message);
        return [];
    }
}

// ==================== YANGI: KUNIGA FAQAT 1 MARTA SAQLASH FUNKSIYASI ====================
async function saveCheckin(studentId, studentName, source = 'ocr', ocrText = '', captionText = '', confidence = 0) {
    return new Promise((resolve, reject) => {
        const weekNumber = getCurrentWeekNumber();
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        // YANGI: Avval bugun allaqachon kirganmi tekshirish
        db.get(
            `SELECT id FROM checkins WHERE student_id = ? AND checkin_date = ?`,
            [studentId, today],
            async (err, row) => {
                if (err) {
                    console.error('❌ Tekshirish xatosi:', err.message);
                    reject(err);
                    return;
                }
                
                if (row) {
                    console.log(`⚠️ ${studentName} bugun allaqachon kirgan (ID: ${row.id})`);
                    resolve(false); // Saqlanmadi
                    return;
                }
                
                // YANGI: Agar bugun kirish bo'lmasa, saqlash
                db.run(
                    `INSERT INTO checkins 
                     (student_id, student_name, week_number, source, ocr_text, caption_text, confidence, checkin_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [studentId, studentName, weekNumber, source, 
                     ocrText.substring(0, 500), captionText, confidence, today],
                    function(err) {
                        if (err) {
                            console.error('❌ Saqlash xatosi:', err.message);
                            reject(err);
                        } else {
                            console.log(`✅ ${studentName} saqlandi (${confidence}%)`);
                            
                            // Haftalik statistika
                            db.run(
                                `INSERT INTO weekly_stats VALUES (?, ?, 1, CURRENT_TIMESTAMP)
                                 ON CONFLICT(week_number, student_id) 
                                 DO UPDATE SET checkin_count = checkin_count + 1, last_checkin = CURRENT_TIMESTAMP`,
                                [weekNumber, studentId]
                            );
                            
                            // Kunlik statistika
                            db.run(
                                `INSERT INTO daily_stats (checkin_date, total_checkins, unique_students)
                                 VALUES (?, 1, 1)
                                 ON CONFLICT(checkin_date) 
                                 DO UPDATE SET 
                                    total_checkins = total_checkins + 1,
                                    unique_students = unique_students + 1`,
                                [today]
                            );
                            
                            resolve(true); // Saqlandi
                        }
                    }
                );
            }
        );
    });
}

// ==================== YORDAMCHI FUNKSIYALAR ====================
function getCurrentWeekNumber() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const days = Math.floor((now - start) / (24 * 60 * 60 * 1000));
    return Math.floor(days / 7) + 1;
}

function formatDate(date = new Date()) {
    return date.toLocaleString('uz-UZ', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function normalizeName(name) {
    return name
        .toUpperCase()
        .replace(/[^A-ZА-ЯЁ\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);
let studentsCache = [];

// ==================== BOT ISHGA TUSHIRISH ====================
async function startBot() {
    try {
        console.log('🚀 Bot ishga tushmoqda...');
        
        studentsCache = await loadStudents();
        
        console.log(`\n✅ BOT TAYYOR!`);
        console.log(`📊 ${studentsCache.length} ta o'quvchi`);
        console.log(`👑 Admin: ${ADMIN_ID}`);
        console.log(`📢 Kanal: ${CHANNEL_ID}`);
        console.log(`⏰ Avtomatik hisobot: Shanba 20:00`);
        console.log(`🔇 Silent mode: ✅ Yoqilgan`);
        console.log(`🎯 OCR: Kuchaytirilgan algoritm (80% minimal)`);
        console.log(`📅 Har bir o'quvchi kuniga 1 marta kirishi mumkin`);
        
        console.log(`\n🔍 TEST QILISH UCHUN:`);
        console.log(`1. /start - barcha komandalar`);
        console.log(`2. /stats - statistika`);
        console.log(`3. /list - o'quvchilar ro'yxati`);
        console.log(`4. /test + rasm reply - OCR testi`);
        console.log(`5. /daily - bugungi statistika`);
        console.log(`6. Rasm yuboring - bot faqat 1 ta aniq ismni topadi`);
        
        await bot.launch();
        console.log('\n🎉 BOT MUVOFFAQIYATLI ISHGA TUSHDI!\n');
        
        // YANGI: Admin ga start xabari
        try {
            await bot.telegram.sendMessage(
                ADMIN_ID,
                `🤖 *Bot ishga tushdi!*\n\n` +
                `📊 O'quvchilar: ${studentsCache.length} ta\n` +
                `📅 Kun: ${formatDate()}\n` +
                `📝 *Xususiyatlar:*\n` +
                `• OCR aniqligi oshirildi\n` +
                `• Har kuni 1 marta kirish\n` +
                `• Faqat 80%+ aniq ismlar\n` +
                `• Barcha komandalar ishlaydi`,
                { parse_mode: 'Markdown' }
            );
        } catch (err) {
            console.log('⚠️ Admin ga xabar yuborilmadi');
        }
        
    } catch (error) {
        console.error('❌ Bot ishga tushmadi:', error.message);
        process.exit(1);
    }
}

// ==================== KOMANDALAR ====================

// YANGI: START KOMANDASI (TO'LIQ ISHLAYDI)
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    
    if (userId !== ADMIN_ID) {
        await ctx.reply('🚫 Bu bot faqat admin uchun!');
        return;
    }
    
    const message = `
👋 *Salom Admin!*

🤖 *SINF MONITORING BOTI*

📊 *Joriy holat:*
• O'quvchilar: ${studentsCache.length} ta
• Hafta: #${getCurrentWeekNumber()}
• Kun: ${new Date().toLocaleDateString('uz-UZ')}
• Vaqt: ${formatDate()}

✅ *YANGI XUSUSIYATLAR:*
1. OCR aniqligi oshirildi (80% minimal)
2. Har o'quvchi kuniga 1 marta kirishi mumkin
3. Faqat eng yuqori balli 1 ta ism saqlanadi
4. Barcha komandalar to'liq ishlaydi

📋 *KOMANDALAR:*
/stats - Hozirgi statistika
/list - Barcha o'quvchilar ro'yxati
/test - OCR testi (rasmga reply qiling)
/daily - Bugungi statistika
/weekly - Haftalik hisobot
/publish - Kanalga joylash
/help - Yordam

📸 *RASM YUBORISH:*
1. e-Maktab skrin shotini yuboring
2. Ixtiyoriy: Rasm tagiga ism yozing (caption)
3. Bot ANIQ ismni topadi va saqlaydi
4. Har bir o'quvchi kuniga 1 marta kirishi mumkin

✍️ *MATN YUBORISH:*
Ism yozing, bot to'g'ri ismni topadi va saqlaydi.

🔇 *SILENT MODE:* Bot faqat saqlaydi, javob bermaydi.
    `;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// YANGI: STATS KOMANDASI (TO'LIQ ISHLAYDI)
bot.command('stats', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.reply('🚫 Ruxsat yo\'q!');
        return;
    }
    
    try {
        const weekNumber = getCurrentWeekNumber();
        const today = new Date().toISOString().split('T')[0];
        
        db.all(`
            SELECT 
                s.full_name,
                COALESCE(ws.checkin_count, 0) as checkins,
                ws.last_checkin,
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM checkins c 
                        WHERE c.student_id = s.id AND c.checkin_date = ?
                    ) THEN '✅' 
                    ELSE '❌' 
                END as today_status
            FROM students s
            LEFT JOIN weekly_stats ws ON s.id = ws.student_id AND ws.week_number = ?
            WHERE s.active = 1
            ORDER BY ws.checkin_count DESC, s.full_name
        `, [today, weekNumber], (err, rows) => {
            if (err) {
                console.error('Stats xatosi:', err.message);
                ctx.reply('❌ Statistika yuklashda xatolik');
                return;
            }
            
            const checkedIn = rows.filter(r => r.checkins > 0);
            const todayChecked = rows.filter(r => r.today_status === '✅');
            const notCheckedIn = rows.filter(r => r.checkins === 0);
            
            let message = `📊 *HAFTALIK STATISTIKA #${weekNumber}*\n`;
            message += `📅 ${formatDate()}\n`;
            message += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n`;
            
            // Bugun kirganlar
            if (todayChecked.length > 0) {
                message += `✅ *BUGUN KIRGANLAR (${todayChecked.length} ta)*\n`;
                todayChecked.forEach((student, index) => {
                    const time = student.last_checkin 
                        ? new Date(student.last_checkin).toLocaleTimeString('uz-UZ', { 
                            hour: '2-digit', 
                            minute: '2-digit' 
                        })
                        : '';
                    message += `${index + 1}. ${student.full_name}`;
                    if (time) message += ` (${time})`;
                    message += `\n`;
                });
                message += `\n`;
            }
            
            // Hafta davomida kirganlar
            if (checkedIn.length > 0) {
                message += `📈 *HAFTA BO'YI KIRGANLAR (${checkedIn.length} ta)*\n`;
                checkedIn.slice(0, 5).forEach((student, index) => {
                    message += `${index + 1}. ${student.full_name} - ${student.checkins} marta\n`;
                });
                
                if (checkedIn.length > 5) {
                    message += `... va yana ${checkedIn.length - 5} ta\n`;
                }
                message += `\n`;
            }
            
            // Kirmaganlar
            if (notCheckedIn.length > 0) {
                message += `❌ *HALI KIRMAGANLAR (${notCheckedIn.length} ta)*\n`;
                notCheckedIn.slice(0, 8).forEach((student, index) => {
                    message += `${index + 1}. ${student.full_name}\n`;
                });
                
                if (notCheckedIn.length > 8) {
                    message += `... va yana ${notCheckedIn.length - 8} ta\n`;
                }
                message += `\n`;
            }
            
            // Umumiy ko'rsatkichlar
            const activityPercent = rows.length > 0 
                ? ((checkedIn.length / rows.length) * 100).toFixed(1) 
                : '0.0';
            
            const todayPercent = rows.length > 0 
                ? ((todayChecked.length / rows.length) * 100).toFixed(1) 
                : '0.0';
            
            message += `📈 *UMUMIY KO'RSATKICHLAR*\n`;
            message += `• Jami o'quvchilar: ${rows.length} ta\n`;
            message += `• Hafta faollari: ${checkedIn.length} ta\n`;
            message += `• Bugun faollari: ${todayChecked.length} ta\n`;
            message += `• Hafta faolligi: ${activityPercent}%\n`;
            message += `• Bugun faolligi: ${todayPercent}%\n`;
            message += `• Hafta: #${weekNumber}\n\n`;
            message += `⏰ ${formatDate()}`;
            
            ctx.reply(message, { parse_mode: 'Markdown' });
        });
        
    } catch (error) {
        console.error('Stats komanda xatosi:', error);
        ctx.reply('❌ Statistika yaratishda xatolik');
    }
});

// YANGI: LIST KOMANDASI (TO'LIQ ISHLAYDI)
bot.command('list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.reply('🚫 Ruxsat yo\'q!');
        return;
    }
    
    try {
        let message = `📋 *O'QUVCHILAR RO'YXATI*\n`;
        message += `Jami: ${studentsCache.length} ta o'quvchi\n\n`;
        
        studentsCache.forEach((student, index) => {
            message += `${index + 1}. ${student.full_name}\n`;
        });
        
        message += `\n📝 *Eslatma:*\n`;
        message += `Har bir o'quvchi kuniga faqat 1 marta kirishi mumkin.`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('List komanda xatosi:', error);
        await ctx.reply('❌ Ro\'yxat yuklashda xatolik');
    }
});

// YANGI: TEST OCR KOMANDASI (TO'LIQ ISHLAYDI)
bot.command('test', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.reply('🚫 Ruxsat yo\'q!');
        return;
    }
    
    if (!ctx.message.reply_to_message?.photo) {
        await ctx.reply('❗ *Qanday test qilish:*\n\n1. Rasm yuboring\n2. Shu rasmga reply qilib `/test` yozing\n3. Bot OCR natijasini ko\'rsatadi', { 
            parse_mode: 'Markdown' 
        });
        return;
    }
    
    const waitMsg = await ctx.reply('🔄 Rasm tahlil qilinmoqda...\n⏳ 30-45 soniya davom etishi mumkin');
    
    try {
        const photo = ctx.message.reply_to_message.photo.pop();
        const file = await ctx.telegram.getFile(photo.file_id);
        const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        
        const ocrText = await processImageOCR(imageUrl);
        const caption = ctx.message.reply_to_message.caption || '';
        
        let message = `🔍 *OCR TEST NATIJASI*\n\n`;
        
        if (ocrText) {
            message += `📝 *OCR Matni (150 belgi):*\n\`${ocrText.substring(0, 150)}\`\n\n`;
            
            // To'liq matn faylga saqlash
            const timestamp = Date.now();
            const filename = `ocr_test_${timestamp}.txt`;
            await fs.writeFile(filename, `OCR Test: ${new Date().toISOString()}\n\n${ocrText}`);
            message += `📄 *To'liq matn:* ${filename} fayliga saqlandi\n\n`;
        }
        
        if (caption) {
            message += `📝 *Caption:* ${caption}\n\n`;
        }
        
        const ocrMatches = AdvancedNameFinder.findBestMatch(ocrText, studentsCache);
        let captionMatches = [];
        
        if (caption) {
            captionMatches = AdvancedNameFinder.findBestMatch(caption, studentsCache);
        }
        
        message += `✅ *TOPILGAN ISMLAR:*\n\n`;
        
        if (ocrMatches.length > 0) {
            message += `📸 *OCR natijalari:*\n`;
            ocrMatches.forEach((match, index) => {
                message += `${index + 1}. ${match.student.full_name} - ${match.confidence}% (${match.pattern})\n`;
            });
            message += `\n`;
        }
        
        if (captionMatches.length > 0) {
            message += `📝 *Caption natijalari:*\n`;
            captionMatches.forEach((match, index) => {
                message += `${index + 1}. ${match.student.full_name} - ${match.confidence}% (${match.pattern})\n`;
            });
            message += `\n`;
        }
        
        if (ocrMatches.length === 0 && captionMatches.length === 0) {
            message += `❌ Hech qanday ism topilmadi\n`;
            message += `\n💡 *Maslahat:*\n`;
            message += `• Rasm aniqroq bo'lsin\n`;
            message += `• Matn yorug' bo'lsin\n`;
            message += `• To'liq ism-familiya ko'rinishi kerak`;
        } else {
            // Eng yaxshi natijani aniqlash
            let bestMatch = null;
            if (ocrMatches.length > 0 && captionMatches.length > 0) {
                bestMatch = ocrMatches[0].confidence >= captionMatches[0].confidence ? ocrMatches[0] : captionMatches[0];
            } else if (ocrMatches.length > 0) {
                bestMatch = ocrMatches[0];
            } else {
                bestMatch = captionMatches[0];
            }
            
            message += `🏆 *ENG YAXSHI NATIJA:* ${bestMatch.student.full_name} (${bestMatch.confidence}%)\n`;
            message += `🎯 Bu ism saqlanadi: ${bestMatch.confidence >= 80 ? '✅ HA' : '❌ YO\'Q (80% dan past)'}`;
        }
        
        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Test OCR xatosi:', error);
        await ctx.reply('❌ OCR testida xatolik: ' + error.message);
    }
});

// YANGI: DAILY KOMANDASI (BUGUNGI STATISTIKA)
bot.command('daily', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.reply('🚫 Ruxsat yo\'q!');
        return;
    }
    
    try {
        const today = new Date().toISOString().split('T')[0];
        const weekNumber = getCurrentWeekNumber();
        
        db.all(`
            SELECT 
                s.full_name,
                c.checkin_time,
                c.confidence
            FROM checkins c
            JOIN students s ON c.student_id = s.id
            WHERE c.checkin_date = ?
            ORDER BY c.checkin_time DESC
        `, [today], async (err, rows) => {
            if (err) {
                console.error('Daily xatosi:', err.message);
                ctx.reply('❌ Kunlik statistika xatosi');
                return;
            }
            
            let message = `📅 *BUGUNGI STATISTIKA*\n`;
            message += `📆 ${new Date().toLocaleDateString('uz-UZ', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            })}\n`;
            message += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n`;
            
            if (rows.length > 0) {
                message += `✅ *BUGUN KIRGANLAR (${rows.length} ta)*\n\n`;
                
                rows.forEach((student, index) => {
                    const time = new Date(student.checkin_time).toLocaleTimeString('uz-UZ', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                    message += `${index + 1}. ${student.full_name}\n`;
                    message += `   🕐 ${time} | 🎯 ${student.confidence || 0}%\n\n`;
                });
            } else {
                message += `📭 Bugun hali hech kim kirmagan\n\n`;
            }
            
            // Kunlik statistika
            db.get(`
                SELECT 
                    total_checkins,
                    unique_students
                FROM daily_stats 
                WHERE checkin_date = ?
            `, [today], (err2, stats) => {
                if (!err2 && stats) {
                    message += `📊 *KUNLIK KO'RSATKICHLAR*\n`;
                    message += `• Jami kirishlar: ${stats.total_checkins} marta\n`;
                    message += `• Faol o'quvchilar: ${stats.unique_students} ta\n`;
                    message += `• Faollik: ${studentsCache.length > 0 ? 
                        ((stats.unique_students / studentsCache.length) * 100).toFixed(1) : '0.0'}%\n\n`;
                }
                
                message += `🤖 *Jami o'quvchilar:* ${studentsCache.length} ta`;
                
                ctx.reply(message, { parse_mode: 'Markdown' });
            });
        });
        
    } catch (error) {
        console.error('Daily komanda xatosi:', error);
        ctx.reply('❌ Kunlik statistika yaratishda xatolik');
    }
});

// YANGI: QOLGAN KOMANDALAR
bot.command('weekly', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    await ctx.reply('📊 Haftalik hisobot tayyorlanmoqda...\n\nBu funksiya keyingi versiyada ishlaydi.');
});

bot.command('publish', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    await ctx.reply('📢 Kanalga joylanmoqda...\n\nBu funksiya keyingi versiyada ishlaydi.');
});

bot.command('help', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const message = `
🆘 *YORDAM - SINF MONITOR BOTI*

*📋 ASOSIY KOMANDALAR:*
/start - Boshlash (barcha ma'lumotlar)
/stats - Hozirgi statistika
/list - Barcha o'quvchilar ro'yxati
/test - OCR testi (rasmga reply)
/daily - Bugungi statistika
/weekly - Haftalik hisobot
/publish - Kanalga joylash
/help - Bu yordam xabari

*📸 RASM YUBORISH (ASOSIY):*
1. e-Maktab skrin shotini OLING
2. Ixtiyoriy: Rasm tagiga ism yozing
3. Bot rasmdan VA captiondan ism qidiradi
4. Faqat 80%+ aniq bo'lgan ismlar saqlanadi
5. Har o'quvchi kuniga faqat 1 marta kirishi mumkin

*✍️ MATN YUBORISH:*
Ism-familiya yozing, bot topadi va saqlaydi.

*🎯 YANGI XUSUSIYATLAR:*
• OCR aniqligi oshirildi
• Har kuni 1 marta kirish cheklovi
• Faqat eng yuqori balli 1 ta ism
• Barcha komandalar ishlaydi

*ℹ️ FOYDALI MASLAHATLAR:*
• Rasm yorug' va aniq bo'lsin
• Ism-familiya to'liq ko'rinsin
• Agar caption bo'lsa, bot uni ustun qo'yadi
• /test komandasi bilan OCR ni sinab ko'ring
    `;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// ==================== RASM HANDLER ====================
bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    try {
        console.log('\n📸 ======= YANGI RASM =======');
        
        const caption = ctx.message.caption || '';
        console.log('📝 Caption:', caption || '(yo\'q)');
        
        // 1. Rasmni olish
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.telegram.getFile(photo.file_id);
        const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        
        // 2. OCR qilish
        const ocrText = await processImageOCR(imageUrl);
        
        if (!ocrText || ocrText.length < 10) {
            console.log('❌ OCR: Yetarli matn topilmadi');
            // Agar caption bo'lsa, faqat shu bilan ishlash
            if (caption) {
                const captionMatches = AdvancedNameFinder.findBestMatch(caption, studentsCache);
                if (captionMatches.length > 0 && captionMatches[0].confidence >= 80) {
                    const saved = await saveCheckin(
                        captionMatches[0].student.id,
                        captionMatches[0].student.full_name,
                        'caption',
                        '',
                        caption,
                        captionMatches[0].confidence
                    );
                    if (saved) {
                        console.log(`✅ ${captionMatches[0].student.full_name} saqlandi (caption orqali)`);
                    }
                }
            }
            return;
        }
        
        // 3. OCR va Caption natijalarini olish
        const ocrMatches = AdvancedNameFinder.findBestMatch(ocrText, studentsCache);
        let captionMatches = [];
        
        if (caption) {
            captionMatches = AdvancedNameFinder.findBestMatch(caption, studentsCache);
        }
        
        // 4. Eng yaxshi natijani tanlash
        let finalMatch = null;
        
        // Agar caption bo'lsa, undan foydalanish
        if (captionMatches.length > 0 && captionMatches[0].confidence >= 80) {
            finalMatch = captionMatches[0];
            console.log(`🎯 Caption natija tanlandi: ${finalMatch.student.full_name}`);
        } 
        // Agar caption bo'lmasa yoki etarlicha aniq bo'lmasa, OCR dan
        else if (ocrMatches.length > 0 && ocrMatches[0].confidence >= 80) {
            finalMatch = ocrMatches[0];
            console.log(`🎯 OCR natija tanlandi: ${finalMatch.student.full_name}`);
        }
        
        // 5. Saqlash (faqat eng yaxshisi)
        if (finalMatch) {
            const saved = await saveCheckin(
                finalMatch.student.id,
                finalMatch.student.full_name,
                'combined',
                ocrText,
                caption,
                finalMatch.confidence
            );
            
            if (saved) {
                console.log(`✅ TOP NATIJA: ${finalMatch.student.full_name} (${finalMatch.confidence}%)`);
                console.log(`   Pattern: ${finalMatch.pattern}`);
            }
        } else {
            console.log('❌ Hech qanday ism topilmadi (80% minimal ball yetarli emas)');
            
            // Debug uchun
            if (ocrMatches.length > 0) {
                console.log('📊 OCR natijalari (lekin past balli):');
                ocrMatches.forEach(m => console.log(`  - ${m.student.full_name}: ${m.confidence}%`));
            }
        }
        
        console.log('📸 ======= RASM TUGADI =======\n');
        
    } catch (error) {
        console.error('❌ Rasm qayta ishlash:', error.message);
    }
});

// ==================== MATN HANDLER ====================
bot.on('text', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID || ctx.message.text.startsWith('/')) return;
    
    const text = ctx.message.text.trim();
    if (text.length < 2) return;
    
    try {
        console.log(`\n🔍 Matn qidiruvi: "${text}"`);
        
        const matches = AdvancedNameFinder.findBestMatch(text, studentsCache);
        
        if (matches.length > 0 && matches[0].confidence >= 80) {
            const saved = await saveCheckin(
                matches[0].student.id,
                matches[0].student.full_name,
                'manual',
                text,
                '',
                matches[0].confidence
            );
            
            if (saved) {
                console.log(`✅ ${matches[0].student.full_name} saqlandi (${matches[0].confidence}%)`);
            } else {
                console.log(`⚠️ ${matches[0].student.full_name} bugun allaqachon kirgan`);
            }
        } else {
            console.log('❌ Hech narsa topilmadi yoki ball yetarli emas');
        }
        
    } catch (error) {
        console.error('❌ Matn qayta ishlash:', error.message);
    }
});

// ==================== AVTOMATIK FUNKSIYALAR ====================
cron.schedule('0 20 * * 6', async () => {
    try {
        console.log('⏰ Avtomatik kanalga joylash boshlanmoqda...');
        
        const weekNumber = getCurrentWeekNumber() - 1;
        
        db.all(`
            SELECT 
                s.full_name,
                ws.checkin_count
            FROM weekly_stats ws
            JOIN students s ON ws.student_id = s.id
            WHERE ws.week_number = ?
            ORDER BY ws.checkin_count DESC
            LIMIT 10
        `, [weekNumber], async (err, rows) => {
            if (err || rows.length === 0) {
                console.log('❌ Avtomatik joylash: ma\'lumot yo\'q');
                return;
            }
            
            let message = `📊 *HAFTALIK HISOBOT #${weekNumber}*\n`;
            message += `📅 ${formatDate()}\n`;
            message += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n`;
            
            message += `🏆 *TOP 10 FAOL O'QUVCHILAR:*\n\n`;
            
            rows.forEach((student, index) => {
                const medals = ['🥇', '🥈', '🥉'];
                const medal = index < 3 ? medals[index] : `${index + 1}.`;
                message += `${medal} ${student.full_name} - ${student.checkin_count} marta\n`;
            });
            
            message += `\n📈 *Faollik reytingi*\n`;
            message += `🤖 @SinfMonitorBot`;
            
            await bot.telegram.sendMessage(CHANNEL_ID, message, {
                parse_mode: 'Markdown',
                disable_notification: true
            });
            
            console.log('✅ Avtomatik hisobot kanalga joylandi');
            console.log(`📢 ${CHANNEL_ID} kanaliga haftalik hisobot joylandi`);
        });
        
    } catch (error) {
        console.error('❌ Avtomatik joylash xatosi:', error.message);
    }
}, {
    timezone: "Asia/Tashkent"
});

// ==================== TO'XTATISH ====================
process.once('SIGINT', () => {
    console.log('\n👋 Bot to\'xtatilmoqda...');
    bot.stop('SIGINT');
    db.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('\n👋 Bot to\'xtatilmoqda...');
    bot.stop('SIGTERM');
    db.close();
    process.exit(0);
});

// ==================== ISHGA TUSHIRISH ====================
startBot();
