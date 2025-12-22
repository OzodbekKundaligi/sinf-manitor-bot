const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const fs = require('fs').promises;

// ==================== SOZLAMALAR ====================
const BOT_TOKEN = '8147643248:AAFus5h1HV-Sy71kE-gf31bpUPzfTtUbs_c';
const ADMIN_ID = 7903688837;
const DATABASE_NAME = 'sinf_bot.db';
const STUDENTS_FILE = 'students.txt';

// Vaqt sozlamalari
const WEEK_START_HOUR = 13; // Dushanba 13:00
const REPORT_HOUR = 20;     // Shanba 20:00

// ==================== MA'LUMOTLAR BAZASI ====================
const db = new sqlite3.Database(DATABASE_NAME);

// Bazani yaratish
db.serialize(() => {
    // O'quvchilar jadvali
    db.run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT UNIQUE NOT NULL,
            active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('❌ students jadval xatosi:', err);
        else console.log('✅ students jadval yaratildi');
    });
    
    // Kirishlar jadvali
    db.run(`
        CREATE TABLE IF NOT EXISTS checkins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            student_name TEXT NOT NULL,
            checkin_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            week_number INTEGER NOT NULL,
            source TEXT DEFAULT 'manual',
            FOREIGN KEY (student_id) REFERENCES students (id)
        )
    `, (err) => {
        if (err) console.error('❌ checkins jadval xatosi:', err);
        else console.log('✅ checkins jadval yaratildi');
    });
    
    // Haftalik statistika
    db.run(`
        CREATE TABLE IF NOT EXISTS weekly_stats (
            week_number INTEGER,
            student_id INTEGER,
            checkin_count INTEGER DEFAULT 0,
            last_checkin TIMESTAMP,
            PRIMARY KEY (week_number, student_id),
            FOREIGN KEY (student_id) REFERENCES students (id)
        )
    `, (err) => {
        if (err) console.error('❌ weekly_stats jadval xatosi:', err);
        else console.log('✅ weekly_stats jadval yaratildi');
    });
});

// ==================== YORDAMCHI FUNKSIYALAR ====================

// Ismni standartlashtirish
function normalizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .toUpperCase()
        .replace(/[^A-ZА-ЯЁ\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Hafta raqamini hisoblash
function getCurrentWeekNumber() {
    const now = new Date();
    const startOfWeek = new Date(now);
    
    // Dushanbagacha bo'lgan kunlar
    const day = startOfWeek.getDay();
    const diff = day === 0 ? 6 : day - 1;
    
    startOfWeek.setDate(startOfWeek.getDate() - diff);
    startOfWeek.setHours(WEEK_START_HOUR, 0, 0, 0);
    
    if (now < startOfWeek) {
        startOfWeek.setDate(startOfWeek.getDate() - 7);
    }
    
    const epochStart = new Date(1970, 0, 1);
    return Math.floor((startOfWeek - epochStart) / (7 * 24 * 60 * 60 * 1000));
}

// Vaqtni formatlash
function formatTime(date = new Date()) {
    return date.toLocaleString('uz-UZ', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// O'quvchilar ro'yxatini yuklash
async function loadStudentsList() {
    try {
        console.log('📋 O\'quvchilar ro\'yxati yuklanmoqda...');
        
        const data = await fs.readFile(STUDENTS_FILE, 'utf8');
        const rawStudents = data
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        
        if (rawStudents.length === 0) {
            console.log('❌ students.txt fayli bo\'sh');
            return [];
        }
        
        let addedCount = 0;
        const students = [];
        
        for (const studentName of rawStudents) {
            try {
                const normalized = normalizeName(studentName);
                
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT OR IGNORE INTO students (full_name) VALUES (?)',
                        [normalized],
                        function(err) {
                            if (err) {
                                console.error(`❌ ${studentName} qo'shish xatosi:`, err.message);
                                reject(err);
                            } else {
                                if (this.changes > 0) {
                                    addedCount++;
                                    console.log(`✅ ${normalized} qo'shildi`);
                                }
                                students.push({
                                    id: this.lastID,
                                    full_name: normalized
                                });
                                resolve();
                            }
                        }
                    );
                });
                
            } catch (error) {
                console.error(`❌ ${studentName} qayta ishlash xatosi:`, error.message);
            }
        }
        
        console.log(`✅ ${students.length} ta o'quvchi yuklandi (${addedCount} ta yangi)`);
        return students;
        
    } catch (error) {
        console.error('❌ Faylni oqish xatosi:', error.message);
        return [];
    }
}

// Barcha o'quvchilarni olish
function getAllStudents() {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id, full_name FROM students WHERE active = 1 ORDER BY full_name',
            (err, rows) => {
                if (err) {
                    console.error('❌ Oquvchilarni olish xatosi:', err);
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            }
        );
    });
}

// O'quvchini ism bo'yicha qidirish
function findStudentByName(name) {
    return new Promise((resolve, reject) => {
        const normalized = normalizeName(name);
        
        db.get(
            'SELECT * FROM students WHERE full_name = ? AND active = 1',
            [normalized],
            (err, row) => {
                if (err) {
                    console.error('❌ Oquvchi qidirish xatosi:', err);
                    reject(err);
                } else {
                    resolve(row || null);
                }
            }
        );
    });
}

// O'xshashlikni hisoblash
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = normalizeName(str1);
    const s2 = normalizeName(str2);
    
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0;
    
    // Agar biri ikkinchisini o'z ichiga olsa
    if (s1.includes(s2) || s2.includes(s1)) {
        return 0.85;
    }
    
    // So'zlar bo'yicha solishtirish
    const words1 = s1.split(' ');
    const words2 = s2.split(' ');
    
    let totalScore = 0;
    let matches = 0;
    
    for (const word1 of words1) {
        if (word1.length < 3) continue;
        
        for (const word2 of words2) {
            if (word2.length < 3) continue;
            
            if (word1 === word2) {
                totalScore += 1.0;
                matches++;
                break;
            }
            
            if (word1.includes(word2) || word2.includes(word1)) {
                totalScore += 0.7;
                matches++;
                break;
            }
        }
    }
    
    if (matches === 0) return 0;
    
    const score1 = totalScore / words1.length;
    const score2 = totalScore / words2.length;
    
    return Math.max(score1, score2);
}

// Matndan o'quvchini topish
async function findStudentInText(text, students) {
    const normalizedText = normalizeName(text);
    console.log(`🔍 Matndan qidirilmoqda: "${normalizedText}"`);
    
    if (!students || students.length === 0) {
        console.log('❌ Oquvchilar royxati bosh');
        return null;
    }
    
    let bestMatch = null;
    let bestScore = 0;
    const threshold = 0.65;
    
    for (const student of students) {
        const studentName = student.full_name;
        const similarity = calculateSimilarity(normalizedText, studentName);
        
        console.log(`   ${studentName} - ${(similarity * 100).toFixed(1)}%`);
        
        if (similarity > bestScore && similarity >= threshold) {
            bestScore = similarity;
            bestMatch = student;
        }
    }
    
    if (bestMatch) {
        console.log(`✅ Topildi: ${bestMatch.full_name} (${(bestScore * 100).toFixed(1)}%)`);
        return {
            student: bestMatch,
            score: bestScore
        };
    }
    
    console.log(`❌ Topilmadi (eng yaxshi: ${(bestScore * 100).toFixed(1)}%)`);
    return null;
}

// Kirish qayd etish (SILENT MODE)
function addCheckin(studentId, studentName, source = 'manual') {
    return new Promise((resolve, reject) => {
        const weekNumber = getCurrentWeekNumber();
        
        db.run(
            `INSERT INTO checkins (student_id, student_name, week_number, source) 
             VALUES (?, ?, ?, ?)`,
            [studentId, studentName, weekNumber, source],
            function(err) {
                if (err) {
                    console.error('❌ Kirish qayd etish xatosi:', err);
                    reject(err);
                    return;
                }
                
                // Haftalik statistika yangilash
                db.run(
                    `INSERT INTO weekly_stats (week_number, student_id, checkin_count, last_checkin)
                     VALUES (?, ?, 1, CURRENT_TIMESTAMP)
                     ON CONFLICT(week_number, student_id) 
                     DO UPDATE SET 
                        checkin_count = checkin_count + 1,
                        last_checkin = CURRENT_TIMESTAMP`,
                    [weekNumber, studentId],
                    (updateErr) => {
                        if (updateErr) {
                            console.error('❌ Statistika yangilash xatosi:', updateErr);
                        }
                    }
                );
                
                console.log(`✅ Saqlandi: ${studentName} (hafta #${weekNumber})`);
                resolve({
                    id: this.lastID,
                    week: weekNumber,
                    time: new Date().toISOString()
                });
            }
        );
    });
}

// Haftalik statistika olish
function getWeeklyStats(weekNumber = null) {
    return new Promise((resolve, reject) => {
        const targetWeek = weekNumber || getCurrentWeekNumber();
        
        db.all(`
            SELECT 
                s.full_name,
                COALESCE(ws.checkin_count, 0) as checkin_count,
                ws.last_checkin,
                CASE 
                    WHEN COALESCE(ws.checkin_count, 0) > 0 THEN 1 
                    ELSE 0 
                END as has_checked_in
            FROM students s
            LEFT JOIN weekly_stats ws ON s.id = ws.student_id 
                AND ws.week_number = ?
            WHERE s.active = 1
            ORDER BY checkin_count DESC, s.full_name
        `, [targetWeek], (err, rows) => {
            if (err) {
                console.error('❌ Statistika olish xatosi:', err);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Umumiy statistika
function getGeneralStats() {
    return new Promise((resolve, reject) => {
        const currentWeek = getCurrentWeekNumber();
        
        db.get(`
            SELECT 
                (SELECT COUNT(*) FROM students WHERE active = 1) as total_students,
                (SELECT COUNT(DISTINCT student_id) FROM checkins 
                 WHERE date(checkin_time) = date('now')) as today_active,
                (SELECT COUNT(*) FROM checkins 
                 WHERE date(checkin_time) = date('now')) as today_checkins,
                (SELECT COUNT(*) FROM checkins 
                 WHERE week_number = ?) as week_checkins
        `, [currentWeek], (err, row) => {
            if (err) {
                console.error('❌ Umumiy statistika xatosi:', err);
                reject(err);
            } else {
                resolve(row || {
                    total_students: 0,
                    today_active: 0,
                    today_checkins: 0,
                    week_checkins: 0
                });
            }
        });
    });
}

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// O'zgaruvchilar
let studentsCache = [];

// ==================== BOTNI ISHGA TUSHIRISH ====================
async function initializeBot() {
    try {
        console.log('🚀 Bot ishga tushmoqda...');
        
        // O'quvchilar ro'yxatini yuklash
        studentsCache = await loadStudentsList();
        if (studentsCache.length === 0) {
            studentsCache = await getAllStudents();
        }
        
        console.log(`✅ Bot tayyor! ${studentsCache.length} ta o'quvchi`);
        console.log(`🔇 Silent mode: Yoqilgan`);
        
        // Admin ga start xabari (faqat bir marta)
        const startMessage = `
🤖 *SINF MONITOR BOTI ISHGA TUSHDI!*

📊 *Statistika:*
• O'quvchilar: ${studentsCache.length} ta
• Hafta: #${getCurrentWeekNumber()}
• Vaqt: ${formatTime()}

📅 *Ish tartibi:*
• Dushanba ${WEEK_START_HOUR}:00 - hafta boshlanishi
• Shanba ${REPORT_HOUR}:00 - avtomatik hisobot
• /stats - joriy statistika
• /report - haftalik hisobot

📸 *Rasm yuborish:* Rasm + caption (ism-familiya)
✍️ *Matn yuborish:* Ism-familiya

*Eslatma:* Bot faqat saqlaydi, tasdiq yubormaydi!
        `;
        
        await bot.telegram.sendMessage(ADMIN_ID, startMessage, { 
            parse_mode: 'Markdown'
        });
        
    } catch (error) {
        console.error('❌ Botni ishga tushirish xatosi:', error);
    }
}

// ==================== KOMANDA HANDLERLARI ====================

// Start komandasi
bot.command('start', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const message = `
👋 *Salom Admin!*

🤖 *Sinf Monitor Boti (Silent Mode)*

*Asosiy komandalar:*
/stats - Hozirgi statistika
/list - To'liq ro'yxat
/report - Hisobot yuborish
/help - Yordam

📸 *Rasm yuborish:*
1. e-Maktab skrin shotini yuboring
2. Rasm tagiga ism yozing (caption)
3. Bot avtomatik saqlaydi (tasdiqsiz)

✍️ *Matn yuborish:*
Ism-familiyani yozing, bot saqlaydi

🔇 *Silent mode:* Hech qanday tasdiq xabari yo'q
    `;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// Statistika komandasi
bot.command('stats', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    try {
        const weekNumber = getCurrentWeekNumber();
        const stats = await getWeeklyStats(weekNumber);
        const general = await getGeneralStats();
        
        if (!stats || stats.length === 0) {
            await ctx.reply('📭 Hech qanday ma\'lumot topilmadi');
            return;
        }
        
        const checkedIn = stats.filter(s => s.has_checked_in);
        const notCheckedIn = stats.filter(s => !s.has_checked_in);
        
        let message = `📊 *HAFTALIK STATISTIKA #${weekNumber}*\n`;
        message += `📅 ${formatTime()}\n`;
        message += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n`;
        
        if (checkedIn.length > 0) {
            message += `✅ *KIRGANLAR (${checkedIn.length} ta)*\n`;
            checkedIn.slice(0, 15).forEach((student, index) => {
                const time = student.last_checkin 
                    ? new Date(student.last_checkin).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })
                    : '';
                message += `${index + 1}. ${student.full_name} - ${student.checkin_count} marta ${time ? `(${time})` : ''}\n`;
            });
            
            if (checkedIn.length > 15) {
                message += `... va yana ${checkedIn.length - 15} ta\n`;
            }
            message += '\n';
        }
        
        if (notCheckedIn.length > 0) {
            message += `❌ *KIRMAGANLAR (${notCheckedIn.length} ta)*\n`;
            const firstTen = notCheckedIn.slice(0, 10);
            firstTen.forEach((student, index) => {
                message += `${index + 1}. ${student.full_name}\n`;
            });
            
            if (notCheckedIn.length > 10) {
                message += `... va yana ${notCheckedIn.length - 10} ta\n`;
            }
            message += '\n';
        }
        
        const activityPercent = stats.length > 0 
            ? ((checkedIn.length / stats.length) * 100).toFixed(1) 
            : '0.0';
        
        message += `📈 *UMUMIY KO'RSATKICHLAR*\n`;
        message += `• Jami o'quvchilar: ${stats.length} ta\n`;
        message += `• Faol o'quvchilar: ${checkedIn.length} ta\n`;
        message += `• Faollik: ${activityPercent}%\n`;
        message += `• Hafta kirishlari: ${general.week_checkins} marta\n`;
        message += `• Bugun kirishlar: ${general.today_checkins} marta\n`;
        message += `• Hafta: #${weekNumber}\n\n`;
        message += `⏰ ${formatTime()}`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Statistika xatosi:', error);
    }
});

// Ro'yxat komandasi
bot.command('list', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    try {
        const students = await getAllStudents();
        
        if (!students || students.length === 0) {
            await ctx.reply('📭 Ro\'yxat bo\'sh. /start bilan yuklang');
            return;
        }
        
        let message = `📋 *O'QUVCHILAR RO'YXATI*\n`;
        message += `Jami: ${students.length} ta\n`;
        message += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n`;
        
        students.forEach((student, index) => {
            message += `${index + 1}. ${student.full_name}\n`;
        });
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Ro\'yxat xatosi:', error);
    }
});

// Hisobot komandasi
bot.command('report', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    try {
        await generateWeeklyReport(ctx);
        
    } catch (error) {
        console.error('Hisobot xatosi:', error);
    }
});

// Yordam komandasi
bot.command('help', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    const helpMessage = `
🆘 *YORDAM - SINF MONITOR BOTI*

*🔇 SILENT MODE:*
• Bot hech qanday tasdiq xabari yubormaydi
• Barcha ma'lumotlar o'z-o'zidan saqlanadi
• Faqat admin so'raganida javob beradi

*📋 ASOSIY KOMANDALAR:*
/stats - Hozirgi statistika (faqat admin)
/list - O'quvchilar ro'yxati (faqat admin)
/report - Haftalik hisobot (faqat admin)

*📸 RASM YUBORISH:*
1. e-Maktab skrin shotini OLING
2. Rasm tagiga ism-familiya YOZING
3. Rasmni botga YUBORING
4. Bot avtomatik SAQLAYDI (tasdiqsiz)

*✍️ MATN YUBORISH:*
1. Ism-familiyani yozing (MAMATOV OZODBEK)
2. Bot saqlaydi (tasdiqsiz)

*⏰ AVTOMATIK REJIM:*
• Har Shanba ${REPORT_HOUR}:00 - avtomatik hisobot
• Hisobot faqat ADMIN ga yuboriladi
    `;
    
    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

// ==================== RASM QABUL QILISH (SILENT MODE) ====================

bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    try {
        // CAPTION ni olish (rasm tagidagi matn)
        const caption = ctx.message.caption;
        
        if (!caption || caption.trim().length < 3) {
            // Agar caption bo'lmasa, o'tkazib yuboramiz (SILENT MODE)
            console.log('📸 Rasm qabul qilindi, lekin caption yo\'q');
            return;
        }
        
        console.log(`📸 Rasm + caption: "${caption}"`);
        
        // O'quvchini caption bo'yicha qidirish
        const studentMatch = await findStudentInText(caption, studentsCache);
        
        if (!studentMatch) {
            console.log(`❌ "${caption}" ro'yxatda topilmadi`);
            return;
        }
        
        // Kirish qayd etish (SILENT)
        await addCheckin(studentMatch.student.id, studentMatch.student.full_name, 'manual');
        
        // Terminalga log yozish
        console.log(`✅ Saqlandi: ${studentMatch.student.full_name} (${(studentMatch.score * 100).toFixed(1)}%)`);
        
    } catch (error) {
        console.error('❌ Rasm qayta ishlash xatosi:', error);
    }
});

// ==================== MATN QABUL QILISH (SILENT MODE) ====================

bot.on('text', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID || ctx.message.text.startsWith('/')) return;
    
    const text = ctx.message.text.trim();
    
    try {
        if (text.length < 3) return;
        
        // O'quvchini qidirish
        const student = await findStudentByName(text);
        
        if (!student) {
            console.log(`❌ "${normalizeName(text)}" ro'yxatda topilmadi`);
            return;
        }
        
        // Kirish qayd etish (SILENT)
        await addCheckin(student.id, student.full_name, 'manual');
        
        // Terminalga log yozish
        console.log(`✅ Saqlandi: ${student.full_name} (qo'lda)`);
        
    } catch (error) {
        console.error('❌ Matn qayta ishlash xatosi:', error);
    }
});

// ==================== HAFTALIK HISOBOT FUNKSIYASI ====================

async function generateWeeklyReport(ctx = null) {
    try {
        const weekNumber = getCurrentWeekNumber();
        const stats = await getWeeklyStats(weekNumber);
        
        if (!stats || stats.length === 0) {
            if (ctx) await ctx.reply('📭 Hisobot uchun ma\'lumot yo\'q');
            return;
        }
        
        const checkedIn = stats.filter(s => s.has_checked_in);
        const notCheckedIn = stats.filter(s => !s.has_checked_in);
        const activityPercent = stats.length > 0 
            ? ((checkedIn.length / stats.length) * 100).toFixed(1) 
            : '0.0';
        
        let report = `📊 *HAFTALIK HISOBOT #${weekNumber}*\n`;
        report += `📅 ${formatTime()}\n`;
        report += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n`;
        
        if (checkedIn.length > 0) {
            report += `🏆 *TOP 10 FAOL O'QUVCHILAR*\n`;
            checkedIn.slice(0, 10).forEach((student, index) => {
                const medals = ['🥇', '🥈', '🥉'];
                const medal = index < 3 ? medals[index] : `${index + 1}.`;
                report += `${medal} ${student.full_name} - ${student.checkin_count} marta\n`;
            });
            report += '\n';
        }
        
        if (notCheckedIn.length > 0) {
            report += `⚠️ *FAOL BO'LMAGANLAR (${notCheckedIn.length} ta)*\n`;
            const firstTen = notCheckedIn.slice(0, 10);
            firstTen.forEach((student, index) => {
                report += `${index + 1}. ${student.full_name}\n`;
            });
            
            if (notCheckedIn.length > 10) {
                report += `... va yana ${notCheckedIn.length - 10} ta\n`;
            }
            report += '\n';
        }
        
        report += `📈 *STATISTIKA*\n`;
        report += `• Jami o'quvchilar: ${stats.length} ta\n`;
        report += `• Faol o'quvchilar: ${checkedIn.length} ta\n`;
        report += `• Faollik darajasi: ${activityPercent}%\n`;
        report += `• Jami kirishlar: ${checkedIn.reduce((sum, s) => sum + s.checkin_count, 0)} marta\n`;
        report += `• O'rtacha kirishlar: ${(checkedIn.reduce((sum, s) => sum + s.checkin_count, 0) / Math.max(checkedIn.length, 1)).toFixed(1)} marta\n\n`;
        
        report += `📅 *KEYINGI HAFTA #${weekNumber + 1}*\n`;
        report += `Boshlanish: Dushanba ${WEEK_START_HOUR}:00\n`;
        report += `Tugash: Shanba ${REPORT_HOUR}:00\n\n`;
        report += `🤖 *Sinf Monitor Boti (Silent Mode)*`;
        
        if (ctx) {
            // Agar admin /report deb so'rasa
            await ctx.reply(report, { parse_mode: 'Markdown' });
        } else {
            // Avtomatik hisobot (faqat Shanba 20:00)
            await bot.telegram.sendMessage(ADMIN_ID, report, { 
                parse_mode: 'Markdown' 
            });
            console.log(`✅ Avtomatik hisobot #${weekNumber} yuborildi`);
        }
        
    } catch (error) {
        console.error('Hisobot xatosi:', error);
        if (ctx) {
            await ctx.reply('❌ Hisobot yaratishda xatolik');
        }
    }
}

// ==================== AVTOMATIK VAZIFALAR ====================

// Har Shanba soat 20:00 da hisobot (faqat admin ga)
cron.schedule('0 20 * * 6', async () => {
    try {
        console.log('⏰ Avtomatik hisobot boshlanmoqda...');
        await generateWeeklyReport();
        console.log('✅ Avtomatik hisobot muvaffaqiyatli yakunlandi');
        
    } catch (error) {
        console.error('❌ Avtomatik hisobot xatosi:', error);
    }
}, {
    timezone: "Asia/Tashkent",
    scheduled: true
});

// ==================== BOTNI ISHGA TUSHIRISH ====================

async function startBot() {
    try {
        // Botni ishga tushirish
        await initializeBot();
        
        // Botni launch qilish
        await bot.launch();
        console.log('🤖 Bot muvaffaqiyatli ishga tushdi!');
        console.log(`👑 Admin ID: ${ADMIN_ID}`);
        console.log(`📅 Avtomatik hisobot: Har Shanba ${REPORT_HOUR}:00`);
        console.log(`📊 Jami o'quvchilar: ${studentsCache.length} ta`);
        console.log(`🔇 Silent mode: ✅ Yoqilgan`);
        console.log(`📝 Terminal loglari faqat`);
        
        // To'xtatish signallari
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
        
    } catch (error) {
        console.error('❌ Botni ishga tushirishda xatolik:', error);
        process.exit(1);
    }
}

// Botni ishga tushirish
startBot();