const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DB = require('./db');

const { i18n: localeI18n, MENUS, MENU_TO_CMD, LANG_FULL, detectLang, langKeyboard } = require('./locales');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_KEY = process.env.GEMINI_KEY || process.env.OPENAI_KEY;
if (!BOT_TOKEN || !OPENAI_KEY) { console.error('Set BOT_TOKEN and GEMINI_KEY/OPENAI_KEY'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  baseURL: process.env.GEMINI_KEY ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : undefined,
});

const AI_MODEL = process.env.GEMINI_KEY ? 'gemini-2.5-flash-lite' : 'gpt-4o';

// ─── Config ───
const FREE_ANALYSIS_LIMIT = 2;
const FREE_CHAT_LIMIT = 10;
const PADDLE_PRICE_ID = process.env.PADDLE_PRICE_ID || 'pri_01khxw8k2hnkfvt7fbhkdxvysy';
const PADDLE_ENV = process.env.PADDLE_ENV || 'sandbox';
const CHECKOUT_BASE = PADDLE_ENV === 'sandbox' ? 'https://sandbox-buy.paddle.com' : 'https://buy.paddle.com';
const CHECKOUT_URL = `${CHECKOUT_BASE}/product/${PADDLE_PRICE_ID}`;
const ADMIN_ID = 5309206282;
const BOT_USERNAME = 'metabolic_center_ai_bot';

// ─── Reminders ───
const reminders = {}; // userId -> [{ time: "HH:MM", meal: "Breakfast", text: "...", active: true }]

function startReminderLoop() {
  setInterval(() => {
    const now = new Date();
    const hhmm = now.toISOString().slice(11, 16); // UTC HH:MM

    for (const [userId, userReminders] of Object.entries(reminders)) {
      for (const r of userReminders) {
        if (r.active && r.utcTime === hhmm && !r.sentToday) {
          const rUser = DB.getUser(parseInt(userId));
          bot.telegram.sendMessage(userId,
            `⏰ *${t(rUser, 'reminder_label')}: ${r.meal}*\n\n${r.text}\n\n${t(rUser, 'bon_appetit')}`,
            { parse_mode: 'Markdown' }
          ).catch(console.error);
          r.sentToday = true;
          setTimeout(() => { r.sentToday = false; }, 120000);
        }
      }
    }
  }, 60000);
}

// ─── Daily food diary summary at 21:00 UTC ───
function startDailySummaryLoop() {
  setInterval(() => {
    const now = new Date();
    const hhmm = now.toISOString().slice(11, 16);
    if (hhmm === '21:00') {
      const usersWithFood = DB.getUsersWithFoodToday();
      for (const { user_id } of usersWithFood) {
        sendFoodSummary(user_id).catch(console.error);
      }
    }
  }, 60000);
}

async function sendFoodSummary(userId) {
  const entries = DB.getTodayFood(userId);
  if (!entries.length) return;
  const user = DB.getUser(userId);
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of entries) {
    totals.calories += e.calories || 0;
    totals.protein += e.protein || 0;
    totals.carbs += e.carbs || 0;
    totals.fat += e.fat || 0;
  }
  const msg = `📊 *${t(user, 'daily_summary_title')}*\n\n🍽 ${t(user, 'meals_logged')}: ${entries.length}\n🔥 ${t(user, 'calories')}: ${totals.calories} kcal\n🥩 ${t(user, 'protein')}: ${totals.protein.toFixed(1)}g\n🍞 ${t(user, 'carbs')}: ${totals.carbs.toFixed(1)}g\n🧈 ${t(user, 'fat')}: ${totals.fat.toFixed(1)}g\n\n${t(user, 'daily_great')}`;
  await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' }).catch(() => {});
}

// ─── Morning detox reminder at 08:00 UTC ───
function startDetoxReminderLoop() {
  setInterval(() => {
    const now = new Date();
    const hhmm = now.toISOString().slice(11, 16);
    if (hhmm === '08:00') {
      // Check all active detox users
      try {
        const rows = DB.db.prepare("SELECT * FROM detox WHERE started_at >= date('now', '-7 days')").all();
        for (const d of rows) {
          const completedArr = d.completed_days ? d.completed_days.split(',').filter(Boolean) : [];
          const currentDay = completedArr.length + 1;
          if (currentDay <= 7) {
            const user = DB.getUser(d.user_id);
            if (!user) continue;
            const themes = ['Hydration', 'Sugar-free', 'Green day', 'Anti-inflammatory', 'Gut health', 'Antioxidants', 'Integration'];
            const theme = themes[currentDay - 1];
            bot.telegram.sendMessage(d.user_id,
              `🧹 *Detox — Day ${currentDay}: ${theme}*\n\n${t(user, 'detox_today_task')}`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
        }
      } catch (e) { console.error('Detox reminder error:', e); }
    }
  }, 60000);
}


// ─── Trial check helper ───
function checkTrialExpiry(user) {
  if (user.is_pro && user.trial_expires && user.trial_expires > 0 && Date.now() > user.trial_expires) {
    user.is_pro = 0;
    user.trial_expires = 0;
    DB.updateUser(user);
    return true; // expired
  }
  return false;
}

function isPro(user) {
  checkTrialExpiry(user);
  return !!user.is_pro;
}

// ─── Translations (loaded from locales.js) ───
const i18n = localeI18n;

// Legacy compat — kept but unused, i18n is now from locales.js

function t(user, key, ...args) {
  const lang = user?.lang || 'en';
  let val = i18n[lang]?.[key] || i18n.en[key] || key;
  if (typeof val === 'string') val = val.replace(/CHECKOUT_URL/g, CHECKOUT_URL);
  return typeof val === 'function' ? val(...args) : val;
}

// In-memory session state
const sessions = {};
function getSession(id) {
  if (!sessions[id]) sessions[id] = { step: null, history: [], awaitingImage: null, awaitingSymptoms: false };
  return sessions[id];
}

const STARS_PRICE_30D = 600; // 600 Stars ≈ $10 for 30 days

const UPGRADE_MSG = `🔒 *Бесплатный лимит исчерпан*

Metabolic Center Pro:

✦ Безлимитный анализ крови
✦ Безлимитный AI чат по здоровью
✦ Персональные планы питания и добавки
✦ Трекинг симптомов и паттернов
✦ Интерпретация мед. документов

Нажмите кнопку ниже для оплаты ⭐`;

// ─── Stars Payment ───
async function sendUpgradeInvoice(ctx, user) {
  const lang = user?.lang || 'en';
  const title = lang === 'ru' ? '💎 Metabolic Center Pro' : '💎 Metabolic Center Pro';
  const desc = lang === 'ru'
    ? 'Pro на 7 дней:\n• Безлимитный анализ крови\n• Персональные планы питания\n• AI чат по здоровью\n• Трекинг симптомов'
    : 'Pro for 30 days:\n• Unlimited blood analysis\n• Personal meal plans\n• AI health chat\n• Symptom tracking';
  try {
    await ctx.replyWithInvoice({
      title,
      description: desc,
      payload: `pro_7d_${ctx.from.id}`,
      currency: 'XTR',
      prices: [{ label: 'Pro 30 days — $10', amount: STARS_PRICE_30D }]
    });
  } catch(e) {
    console.error('Invoice error:', e);
    await ctx.reply(t(user, 'error') || '❌ Error sending invoice. Try again later.');
  }
}

// ─── Prompts ───
const TTS_RULE = `\nIMPORTANT: Write all nutritional terms as full words for text-to-speech compatibility. Never abbreviate: write "Белки" not "Б", "Жиры" not "Ж", "Углеводы" not "У", "Калории" not "К", "Proteins" not "P", "Fats" not "F", "Carbs" not "C". Same for units: "грамм" not "г", "килокалорий" not "ккал" when in running text.\n`;
const ANALYSIS_PROMPT = `You are a metabolic health AI analyst for Metabolic Center — a premium predictive metabolic intelligence platform.

When a user sends a photo of blood test results:

1. Parse all visible biomarkers from the image
2. Compare each against OPTIMAL ranges (functional medicine, not just lab "normal")
3. ALWAYS start your report with:

━━━━━━━━━━━━━━━━━━━━━━━
🧬 METABOLIC INTELLIGENCE REPORT
━━━━━━━━━━━━━━━━━━━━━━━
Metabolic Score: XX/100
Glucose Stability: XX/100
Inflammation Risk: Low/Moderate/High
Estimated Bio Age: XX years (Chrono: XX)
━━━━━━━━━━━━━━━━━━━━━━━

4. Then provide:
- 🔬 Key Findings
- ⚠️ Risk Alerts
- 🎯 Priority Actions (top 3-5)
- 💊 Supplement Protocol
- 🥗 Nutrition Guidance
- 😴 Lifestyle (sleep, exercise, stress)
- 📈 30-Day Protocol

Use sex-specific and age-specific optimal ranges when patient profile is provided.
If pregnant/breastfeeding, use pregnancy-adjusted reference ranges.
If image is NOT a blood test, explain and ask for lab results.
Do not respond in Spanish or any other language unless explicitly told.
End with disclaimer: "AI-generated analysis. Not medical advice. Consult your healthcare provider."`;

const CHAT_PROMPT = `You are the Metabolic Center AI — a world-class integrative health strategist with 20+ years of clinical experience.

You are NOT a generic chatbot. You are a premium ($79/mo) health intelligence system that thinks like the best functional medicine doctors combined: Mark Hyman, Peter Attia, Andrew Huberman, Valter Longo, Chris Palmer.

═══ YOUR DEEP KNOWLEDGE ═══

METABOLIC SCIENCE:
• Insulin resistance mechanics, glucose variability, HbA1c optimization
• Mitochondrial function, NAD+ metabolism, mTOR/AMPK pathways
• Hormonal cascades: cortisol-insulin-leptin-ghrelin axis
• Thyroid metabolism (T3/T4/rT3), adrenal fatigue patterns
• Liver detoxification phases (I, II, III), bile flow, methylation
• Gut-brain axis, microbiome impact on weight and mood
• Inflammation pathways: NF-kB, IL-6, TNF-alpha, CRP

BODY COMPOSITION:
• Set point theory and metabolic adaptation
• Visceral vs subcutaneous fat — different strategies
• Sarcopenia prevention after 40 (muscle = longevity)
• Water retention: lymphatic system, cortisol, sodium/potassium balance
• Why "starvation diets" backfire — metabolic slowdown, muscle loss

PSYCHOSOMATICS & STRESS:
• Cortisol patterns: morning spike, evening drop — and what happens when it's reversed
• Stress-induced weight gain: HPA axis dysfunction
• Emotional eating patterns and neurochemistry (dopamine, serotonin)
• Sleep architecture and its effect on fat metabolism (GH, melatonin)
• "Armor weight" — when the body holds weight as psychological protection

NUTRITION SCIENCE:
• Chrononutrition: WHEN you eat matters as much as WHAT
• Bitter foods and bile stimulation for fat digestion
• Protein timing and leucine threshold for muscle synthesis
• Anti-inflammatory vs pro-inflammatory foods
• Nutrient density vs caloric density
• Mediterranean, Blue Zones, Okinawan patterns
• Fasting protocols: 16:8, 5:2, FMD — who benefits and who doesn't

LONGEVITY:
• Biological age vs chronological age
• Telomere preservation, senescent cell clearance
• Zone 2 cardio, VO2max, grip strength as longevity markers
• Cold/heat exposure protocols
• Rapamycin, metformin, NMN/NR science (discuss, don't prescribe)

═══ HOW TO COMMUNICATE ═══

1. PERSONALIZE EVERYTHING. Use the user's profile (age, weight, height, activity, goals, restrictions). A 25-year-old athlete and a 50-year-old sedentary office worker get completely different advice.

2. EXPLAIN THE WHY. Don't just say "eat protein" — explain "At 45, you lose ~1% muscle mass per year. Each meal needs 30g+ protein with leucine to trigger muscle protein synthesis."

3. BE A STRATEGIST, NOT A MENU GENERATOR. Think: "What is the ROOT CAUSE of this person's problem?" Is it cortisol? Insulin? Sleep? Gut? Then build a strategy around that.

4. GIVE PROTOCOLS, NOT TIPS. Structure like:
   • Phase 1 (Week 1-2): [specific actions]
   • Phase 2 (Week 3-4): [progression]
   • Maintenance: [long-term strategy]

5. USE METAPHORS. "Your cortisol is like a car alarm that won't stop — we need to reset it." "Think of your liver as a filter — if it's clogged, everything backs up."

6. ASK FOLLOW-UP QUESTIONS. "When do you usually feel most bloated?", "What does your sleep look like?", "How do you feel after eating bread?"

7. CONNECT THE DOTS. "Your afternoon crashes + belly fat + poor sleep = classic insulin resistance pattern. Here's what we do..."

FORMATTING:
- Use emojis for structure (🍳🥗🍽💊📊✅⚠️ etc.)
- Use *bold* for headings and key info
- Use bullet points (•) for lists
- Include calories and macros when discussing food/meals
- Make responses look premium and polished

LANGUAGE: Respond in the SAME language the user writes in. If they write in Russian — respond in Russian. English — in English. Georgian — in Georgian. Etc.

End health advice with: "AI-generated guidance, not medical advice."

`;

const MEAL_PLAN_PROMPT_1DAY = `You are a world-class precision nutrition strategist for Metabolic Center.
Generate a detailed 1-DAY personalized meal plan that reads like advice from a top functional medicine doctor.

STRATEGY (adapt to user profile):
- Calculate TDEE based on age, weight, height, activity, then adjust for goal
- For weight loss: 15-20% deficit (NEVER more — protect metabolism)
- For muscle: slight surplus + protein timing
- Consider AGE-SPECIFIC needs:
  * Under 30: can handle more carbs, focus on performance
  * 30-45: optimize insulin sensitivity, increase protein
  * 45+: prioritize protein (1.2-1.6g/kg), anti-inflammatory foods, gut health, manage cortisol
- EXPLAIN WHY each meal is designed this way

FORMAT:
━━━━━━━━━━━━━━━━━━━━━
📊 *Daily Target: XXXXkcal | P: XXXg | C: XXXg | F: XXXg*
🎯 *Strategy: [explain the approach for this person]*
━━━━━━━━━━━━━━━━━━━━━

🌅 *Breakfast (XX:XX)* — XXX kcal
• [dish with portion in grams] — P/C/F
💡 *Why:* [brief explanation — e.g. "protein + fat first stabilizes glucose for 4-5 hours"]

🥗 *Lunch (XX:XX)* — XXX kcal
• [dish with portion] — P/C/F
💡 *Why:* [explanation]

🥜 *Snack (XX:XX)* — XXX kcal
• [dish with portion] — P/C/F

🍽 *Dinner (XX:XX)* — XXX kcal
• [dish with portion] — P/C/F
💡 *Why:* [explanation — e.g. "light dinner before 19:00 = better GH release during sleep"]

💧 *Hydration:* X liters (warm water recommended if bloating/retention issues)
🚫 *Avoid today:* [specific items based on goal]
✅ *Bonus tip:* [one powerful insight]

At the end add: "🔒 *Full 7-day plan + shopping list → Pro*"

LANGUAGE: Match the user's language. If profile has Russian localization — write in Russian.

RULES:
- Respect ALL dietary restrictions
- Use LOCAL foods (Georgian cuisine if in Georgia, etc.)
- Be specific with portions (grams)
- Sound like a premium consultation, not a template`;

const MEAL_PLAN_PROMPT_PRO = `You are a precision nutrition AI for Metabolic Center.
Generate a detailed 7-DAY personalized meal plan with variety.

FORMAT for each day:
━━━━━━━━━━━━━━━━━━━━━
📅 *Day X — [theme, e.g. Mediterranean, Asian, etc.]*
📊 *XXXXkcal | P: XXXg | C: XXXg | F: XXXg*

🌅 *Breakfast (XX:XX)* — XXX kcal
• [dish with portion]

🥗 *Lunch (XX:XX)* — XXX kcal
• [dish with portion]

🥜 *Snack (XX:XX)* — XXX kcal
• [dish with portion]

🍽 *Dinner (XX:XX)* — XXX kcal
• [dish with portion]

After all 7 days, add:
🛒 *SHOPPING LIST (week):*
Group by category: 🥩 Protein | 🥬 Vegetables | 🍎 Fruits | 🌾 Grains | 🥛 Dairy | 🥫 Other

RULES:
- Calculate calories based on profile (weight, height, age, activity, goal)
- Respect ALL dietary restrictions
- Vary dishes — don't repeat meals
- Be specific with portions (grams)
- Keep it practical — real dishes, easy to cook`;


const SUPPLEMENT_PROMPT = `You are a supplement protocol AI for Metabolic Center.
Create personalized evidence-based supplement protocol. Include: exact dosages, timing, morning vs evening stack, with food vs empty stomach, best forms, interactions, expected timeline.
End with: "Consult your healthcare provider before starting supplements."`;

const SYMPTOM_PROMPT = `You are a symptom analysis AI for Metabolic Center.
Analyze symptoms: identify metabolic connections, suggest biomarkers to test, recommend lifestyle adjustments, flag urgent items, track patterns.
End with: "This is not a diagnosis. See a doctor for persistent symptoms."`;

const FOOD_PROMPT = `You are a food analysis AI for Metabolic Center.

When a user sends a photo of food/meal:
1. Identify all foods visible. If unsure what a dish is, state your best guess and ask user to correct if wrong.
2. Consider that foods may look different across cultures — mashed potatoes, purées, porridges, hummus etc. can look similar. When in doubt, list 2-3 possibilities.
3. If the user provides a caption describing the food, USE THAT as the primary identification (trust the user over visual guess).
4. Estimate portion sizes
5. Calculate approximate:
   - Total calories
   - Protein / Carbs / Fat (grams)
   - Fiber, sugar estimate
4. Rate the meal:
   - Metabolic Score (0-10): how good is this for metabolic health
   - Glucose Impact: Low/Medium/High (will it spike blood sugar?)
   - Inflammation Score: Anti-inflammatory / Neutral / Pro-inflammatory
5. Give specific feedback:
   - ✅ What's good about this meal
   - ⚠️ What could be better
   - 🔄 Suggested swaps to improve it
   - 🕐 Best time to eat this (morning/midday/evening)
6. If user has a goal (weight loss, energy, longevity), tailor advice to that goal

Format the response clearly with emojis. Be encouraging but honest.
At the end, add: "💡 Not accurate? Reply with the correct dish name and I'll recalculate."
Do not respond in Spanish or any other language unless explicitly told.`;

const FOOD_DIARY_PROMPT = `You are a food analysis AI. Analyze the food photo and respond ONLY with valid JSON (no markdown, no code blocks). Format:
{"description":"brief meal description","calories":NUMBER,"protein":NUMBER,"carbs":NUMBER,"fat":NUMBER}
Estimate as accurately as possible. Numbers only, no units in values.`;

const DOC_PROMPT = `You are a medical document interpreter for Metabolic Center.
Explain findings in simple language, highlight abnormalities, connect to metabolic health.
End with: "AI interpretation. Discuss results with your doctor."`;

const DETOX_PROMPT = `You are a detox program AI for Metabolic Center.
Generate a detailed daily detox plan for the given day and theme.

Include:
1. 🌅 Morning routine (specific steps)
2. 🥗 Meal plan for the day (breakfast, lunch, snack, dinner with portions)
3. 💧 Hydration protocol
4. 🏃 Movement/exercise recommendation
5. 🧘 Mindfulness/relaxation tip
6. ⚠️ What to avoid today
7. 💡 Key tips for success

Make it practical, specific, and encouraging. Tailor to user profile.
Format with emojis and clear structure.`;

// ─── Helpers ───
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getImageBase64(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  return (await downloadFile(url)).toString('base64');
}

function profileContext(user) {
  const lang = LANG_FULL[user?.lang] || 'English';
  let s = `\nIMPORTANT: You MUST respond ONLY in ${lang}. Do not use any other language.`;
  if (!user || (!user.gender && !user.age)) return s;
  s += `\nPatient: ${user.gender || '?'}, ${user.age || '?'} years`;
  if (user.height) s += `, ${user.height} cm`;
  if (user.weight) s += `, ${user.weight} kg`;
  if (user.activity_level) s += `, activity: ${user.activity_level}`;
  if (user.diet_restrictions) s += `. Diet restrictions: ${user.diet_restrictions}`;
  if (user.pregnancy_status && user.pregnancy_status !== 'not pregnant') s += `, ${user.pregnancy_status}`;
  if (user.goal) s += `. Goal: ${user.goal}`;
  return s + '.';
}

async function sendLong(ctx, text, { showTts = true } = {}) {
  let lastMsg;
  if (text.length > 4000) {
    const parts = text.match(/[\s\S]{1,4000}/g);
    for (const p of parts) lastMsg = await ctx.replyWithMarkdown(p).catch(() => ctx.reply(p));
  } else {
    lastMsg = await ctx.replyWithMarkdown(text).catch(() => ctx.reply(text));
  }
  if (showTts && lastMsg) {
    await ctx.reply('⬆️', ttsButton(lastMsg.message_id, lastMsg.text || text)).catch(() => {});
  }
  return lastMsg;
}

function stripMarkdown(text) {
  return text.replace(/[*_`~\[\]()#>]/g, '').replace(/\n{3,}/g, '\n\n');
}

// Separate OpenAI client for TTS (main client may point to Gemini)
const ttsClient = process.env.OPENAI_KEY ? new OpenAI({ apiKey: process.env.OPENAI_KEY }) : null;

async function textToVoice(chatId, text) {
  if (!ttsClient) return;
  const clean = stripMarkdown(text).slice(0, 4000);
  if (!clean.trim()) return;
  let tmpPath;
  try {
    const speech = await ttsClient.audio.speech.create({
      model: 'tts-1', voice: 'nova', input: clean, response_format: 'opus',
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);
    await bot.telegram.sendVoice(chatId, { source: tmpPath });
  } catch (e) {
    console.error('TTS error:', e?.message);
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

const _ttsCache = {};
function ttsButton(msgId, text) {
  if (text) _ttsCache[msgId] = stripMarkdown(text).slice(0, 4000);
  return { reply_markup: { inline_keyboard: [[{ text: '🔊 Озвучить', callback_data: `tts_${msgId}` }]] } };
}

function canUse(user, type) {
  if (isPro(user)) return true;
  if (type === 'analysis') return user.analysis_count < FREE_ANALYSIS_LIMIT;
  if (type === 'chat') return user.chat_count < FREE_CHAT_LIMIT;
  return true;
}

function ensureReferralCode(user) {
  if (!user.referral_code) {
    user.referral_code = 'ref_' + user.id;
    DB.updateUser(user);
  }
  return user.referral_code;
}

// ─── Menu (6 rows, multilingual from locales.js) ───
function getMenu(user) {
  const lang = user?.lang || 'en';
  const rows = MENUS[lang] || MENUS.en;
  return Markup.keyboard(rows).resize();
}

function mealPlanKeyboard(user) {
  return [
    [{ text: t(user, 'mp_balanced'), callback_data: 'mp_balanced' }],
    [{ text: t(user, 'mp_if16'), callback_data: 'mp_if16' }],
    [{ text: t(user, 'mp_keto'), callback_data: 'mp_keto' }],
    [{ text: t(user, 'mp_mediterranean'), callback_data: 'mp_mediterranean' }],
    [{ text: t(user, 'mp_muscle'), callback_data: 'mp_muscle' }],
    [{ text: t(user, 'mp_cut'), callback_data: 'mp_cut' }],
    [{ text: t(user, 'mp_vegan'), callback_data: 'mp_vegan' }],
    [{ text: t(user, 'mp_longevity'), callback_data: 'mp_longevity' }],
  ];
}

// ─── Commands ───
bot.start(async (ctx) => {
  const startPayload = ctx.startPayload || '';
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);
  DB.logEvent(ctx.from.id, 'START', `@${ctx.from.username || ''} ${ctx.from.first_name || ''} payload=${startPayload}`);

  // Handle referral
  if (startPayload.startsWith('ref_')) {
    const referrerCode = startPayload;
    const referrer = DB.getUserByReferral(referrerCode);
    if (referrer && referrer.id !== ctx.from.id && !user.referred_by) {
      user.referred_by = referrer.id;
      DB.updateUser(user);
      // Give referrer +7 days Pro
      const now = Date.now();
      const currentExpiry = (referrer.trial_expires && referrer.trial_expires > now) ? referrer.trial_expires : now;
      referrer.trial_expires = currentExpiry + 7 * 24 * 60 * 60 * 1000;
      referrer.is_pro = 1;
      DB.updateUser(referrer);
      DB.logEvent(referrer.id, 'REFERRAL_BONUS', `from user ${ctx.from.id}`);
      const rRu = referrer.lang === 'ru';
      bot.telegram.sendMessage(referrer.id, t(referrer, 'referral_friend_joined'), { parse_mode: 'Markdown' }).catch(() => {});
    }
  }

  session.step = 'lang';

  // Auto-detect language from Telegram
  const detectedLang = detectLang(ctx.from.language_code);
  if (detectedLang) {
    user.lang = detectedLang;
    DB.updateUser(user);
    session.step = 'gender';
    await ctx.replyWithMarkdown(t(user, 'welcome'), getMenu(user));
    setTimeout(() => {
      ctx.reply(t(user, 'sex_q'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'male'), callback_data: 'gender_male' }, { text: t(user, 'female'), callback_data: 'gender_female' }]
      ]}});
    }, 1000);
  } else {
    await ctx.reply('🌐 Choose your language:', { reply_markup: { inline_keyboard: langKeyboard() }});
  }
});

// Admin: activate Pro for user
bot.command('activate', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.message.text.split(' ');
  const targetId = parseInt(args[1]);
  if (!targetId) { await ctx.reply('Usage: /activate <telegram_user_id>'); return; }
  const user = DB.getUser(targetId);
  if (!user) { await ctx.reply('User not found.'); return; }
  user.is_pro = 1;
  DB.updateUser(user);
  DB.logEvent(targetId, 'PRO_ACTIVATED', 'manual by admin');
  bot.telegram.sendMessage(targetId, '🎉 *Welcome to Metabolic Center Pro!*\n\nYou now have unlimited access to all features. Enjoy!', { parse_mode: 'Markdown' }).catch(() => {});
  await ctx.reply(`✅ User ${targetId} activated as Pro.`);
});

bot.command('deactivate', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const args = ctx.message.text.split(' ');
  const targetId = parseInt(args[1]);
  if (!targetId) { await ctx.reply('Usage: /deactivate <telegram_user_id>'); return; }
  const user = DB.getUser(targetId);
  if (!user) { await ctx.reply('User not found.'); return; }
  user.is_pro = 0;
  DB.updateUser(user);
  await ctx.reply(`❌ User ${targetId} Pro deactivated.`);
});

bot.command('language', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  await ctx.reply(t(user, 'choose_lang'), { reply_markup: { inline_keyboard: langKeyboard() }});
});

bot.command('reminders_off', async (ctx) => {
  delete reminders[ctx.from.id];
  await ctx.reply('⏰ Meal reminders turned off.');
});

bot.command('reminders', async (ctx) => {
  const r = reminders[ctx.from.id];
  if (!r || r.length === 0) {
    await ctx.reply('No reminders set. Use ⏰ Meal Reminders button to set up.');
    return;
  }
  const schedule = r.map(m => `⏰ ${m.localTime} — ${m.meal}: ${m.text}`).join('\n');
  await ctx.reply(`🍽 *Your reminders:*\n\n${schedule}\n\nTurn off: /reminders_off`, { parse_mode: 'Markdown' });
});

bot.command('referral', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const code = ensureReferralCode(user);
  const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
  const count = DB.countReferrals(user.id);
  await ctx.replyWithMarkdown(`${t(user, 'referral_title')}\n\n${t(user, 'referral_text')}${link}\n\n👥 ${t(user, 'referral_stats')}: ${count}`);
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const s = DB.stats();
  const recent = s.recentUsers.map(u =>
    `• ${u.gender || '?'}, ${u.age || '?'}y, ${u.goal || '?'} — 🔬${u.analysis_count} 💬${u.chat_count} (${(u.joined_at || '').slice(0,10)})`
  ).join('\n');
  await ctx.reply(
`📊 Metabolic Center Stats

👥 Total users: ${s.totalUsers}
⭐ Pro: ${s.proUsers}
🔬 Analyses: ${s.totalAnalyses}
💬 Chats: ${s.totalChats}

📅 Today: ${s.todayUsers} new users, ${s.todayActivity} actions

📋 Recent:
${recent || 'No users yet'}`);
});

// ─── Callbacks ───
bot.on('callback_query', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);
  const data = ctx.callbackQuery.data;

  // TTS callback
  if (data.startsWith('tts_')) {
    await ctx.answerCbQuery('🔊 Генерирую голос...');
    const msgId = data.split('_')[1];
    const text = _ttsCache[msgId] || ctx.callbackQuery.message?.text || '';
    if (text && text.trim() !== '⬆️') await textToVoice(ctx.chat.id, text);
    return;
  }

  // Check trial expiry on every callback
  if (checkTrialExpiry(user)) {
    await bot.telegram.sendMessage(ctx.from.id, t(user, 'trial_expired'), { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (data.startsWith('lang_')) {
    user.lang = data.replace('lang_', '');
    DB.updateUser(user);
    await ctx.answerCbQuery();
    await ctx.editMessageText(t(user, 'lang_set'));
    // If user already has a profile (goal set), just update keyboard
    if (user.goal) {
      await ctx.reply(t(user, 'profile_done'), getMenu(user));
    } else {
      session.step = 'gender';
      await ctx.replyWithMarkdown(t(user, 'welcome'), getMenu(user));
      setTimeout(() => {
        ctx.reply(t(user, 'sex_q'), { reply_markup: { inline_keyboard: [
          [{ text: t(user, 'male'), callback_data: 'gender_male' }, { text: t(user, 'female'), callback_data: 'gender_female' }]
        ]}});
      }, 1000);
    }
    return;
  }

  if (data === 'gender_male' || data === 'gender_female') {
    user.gender = data === 'gender_male' ? 'male' : 'female';
    DB.updateUser(user);
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ ${user.gender === 'male' ? t(user, 'male') : t(user, 'female')}`);
    if (user.gender === 'female') {
      session.step = 'pregnant';
      await ctx.reply(t(user, 'pregnant_q'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'preg_yes'), callback_data: 'preg_yes' }],
        [{ text: t(user, 'preg_bf'), callback_data: 'preg_bf' }],
        [{ text: t(user, 'preg_no'), callback_data: 'preg_no' }]
      ]}});
    } else {
      session.step = 'age';
      await ctx.reply(t(user, 'age_q'));
    }
  }

  if (data.startsWith('preg_')) {
    user.pregnancy_status = { preg_yes: 'pregnant', preg_bf: 'breastfeeding', preg_no: 'not pregnant' }[data];
    DB.updateUser(user);
    session.step = 'age';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ ${user.pregnancy_status === 'not pregnant' ? t(user, 'preg_no') : user.pregnancy_status === 'pregnant' ? t(user, 'preg_yes') : t(user, 'preg_bf')}`);
    await ctx.reply(t(user, 'age_q'));
  }

  if (data.startsWith('tz_')) {
    const offset = parseInt(data.replace('tz_', ''));
    user.tz_offset = offset;
    DB.updateUser(user);
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Timezone: UTC${offset >= 0 ? '+' : ''}${offset}`);
    await ctx.reply('Choose your eating schedule:', { reply_markup: { inline_keyboard: [
      [{ text: '🌅 Early Bird (7-12-15-18)', callback_data: 'sched_early' }],
      [{ text: '☀️ Standard (8-13-16-19)', callback_data: 'sched_standard' }],
      [{ text: '🌙 Late Riser (10-14-17-21)', callback_data: 'sched_late' }],
      [{ text: '🔥 IF 16:8 (12-15-19)', callback_data: 'sched_if' }]
    ]}});
    return;
  }

  if (data === 'remind_setup') {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Choose timezone:', { reply_markup: { inline_keyboard: [
      [{ text: '🇬🇪 Tbilisi +4', callback_data: 'tz_4' }, { text: '🇦🇪 Dubai +4', callback_data: 'tz_4' }],
      [{ text: '🇹🇷 Istanbul +3', callback_data: 'tz_3' }, { text: '🇪🇺 Berlin +1', callback_data: 'tz_1' }],
      [{ text: '🇬🇧 London 0', callback_data: 'tz_0' }, { text: '🇺🇸 NY -5', callback_data: 'tz_-5' }]
    ]}});
    return;
  }

  if (data === 'remind_off') {
    delete reminders[ctx.from.id];
    await ctx.answerCbQuery();
    await ctx.editMessageText('⏰ Reminders turned off.');
    return;
  }

  if (data.startsWith('sched_')) {
    const offset = user.tz_offset || 0;
    const schedules = {
      sched_early: [
        { meal: '🥣 Breakfast', localTime: '07:00', text: 'Eggs, avocado toast, or oatmeal with berries and nuts.' },
        { meal: '🥗 Lunch', localTime: '12:00', text: 'Grilled protein + salad + complex carbs (quinoa, sweet potato).' },
        { meal: '🥜 Snack', localTime: '15:00', text: 'Greek yogurt with nuts, or apple with almond butter.' },
        { meal: '🍽 Dinner', localTime: '18:00', text: 'Fish or chicken + roasted vegetables. Keep it light.' }
      ],
      sched_standard: [
        { meal: '🥣 Breakfast', localTime: '08:00', text: 'Protein smoothie, eggs, or oatmeal with fruits.' },
        { meal: '🥗 Lunch', localTime: '13:00', text: 'Balanced plate: protein + veggies + healthy carbs.' },
        { meal: '🥜 Snack', localTime: '16:00', text: 'Handful of nuts, fruit, or protein bar.' },
        { meal: '🍽 Dinner', localTime: '19:00', text: 'Lean protein + vegetables. Finish eating 3h before sleep.' }
      ],
      sched_late: [
        { meal: '🥣 Breakfast', localTime: '10:00', text: 'Big protein breakfast to fuel your day.' },
        { meal: '🥗 Lunch', localTime: '14:00', text: 'Main meal — protein, veggies, healthy fats.' },
        { meal: '🥜 Snack', localTime: '17:00', text: 'Light snack — nuts, hummus, veggies.' },
        { meal: '🍽 Dinner', localTime: '21:00', text: 'Light dinner — soup, salad, or fish.' }
      ],
      sched_if: [
        { meal: '🥗 First meal', localTime: '12:00', text: 'Break your fast with protein + healthy fats + fiber.' },
        { meal: '🥜 Snack', localTime: '15:00', text: 'Protein-rich snack to stay fueled.' },
        { meal: '🍽 Last meal', localTime: '19:00', text: 'Complete meal before your fasting window. Protein + veggies.' }
      ]
    };

    const meals = schedules[data] || schedules.sched_standard;

    reminders[ctx.from.id] = meals.map(m => {
      const [h, min] = m.localTime.split(':').map(Number);
      const utcH = ((h - offset) + 24) % 24;
      return { ...m, utcTime: `${String(utcH).padStart(2,'0')}:${String(min).padStart(2,'0')}`, active: true, sentToday: false };
    });

    DB.logEvent(ctx.from.id, 'REMINDERS_SET', data);
    await ctx.answerCbQuery();
    const schedule = meals.map(m => `⏰ ${m.localTime} — ${m.meal}`).join('\n');
    await ctx.editMessageText(`${t(user, 'remind_set')}\n\n${schedule}\n\n${t(user, 'schedule_set_msg')}`, { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('act_')) {
    const levels = { act_low: 'Sedentary', act_moderate: 'Moderate', act_high: 'High', act_athlete: 'Athlete' };
    const actKeys = { act_low: 'activity_low', act_moderate: 'activity_moderate', act_high: 'activity_high', act_athlete: 'activity_athlete' };
    user.activity_level = levels[data];
    DB.updateUser(user);
    session.step = 'diet';
    session.dietSelections = [];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ ${t(user, actKeys[data])}`);
    await ctx.reply(t(user, 'diet_q'), { reply_markup: { inline_keyboard: [
      [{ text: t(user, 'diet_none'), callback_data: 'diet_none' }],
      [{ text: t(user, 'diet_vegetarian'), callback_data: 'diet_vegetarian' }],
      [{ text: t(user, 'diet_vegan'), callback_data: 'diet_vegan' }],
      [{ text: t(user, 'diet_gluten_free'), callback_data: 'diet_gf' }],
      [{ text: t(user, 'diet_lactose_free'), callback_data: 'diet_lf' }],
      [{ text: t(user, 'diet_halal'), callback_data: 'diet_halal' }],
      [{ text: t(user, 'diet_keto'), callback_data: 'diet_keto' }],
      [{ text: t(user, 'diet_done'), callback_data: 'diet_done' }]
    ]}});
    return;
  }

  if (data.startsWith('diet_')) {
    if (!session.dietSelections) session.dietSelections = [];
    if (data === 'diet_none') {
      session.dietSelections = [];
      user.diet_restrictions = '';
      DB.updateUser(user);
      session.step = 'goal';
      await ctx.answerCbQuery();
      await ctx.editMessageText(`✅ ${t(user, 'no_restrictions')}`);
      await ctx.reply(t(user, 'goal_q'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'goal_energy'), callback_data: 'goal_energy' }],
        [{ text: t(user, 'goal_longevity'), callback_data: 'goal_longevity' }],
        [{ text: t(user, 'goal_weight'), callback_data: 'goal_weight' }],
        [{ text: t(user, 'goal_general'), callback_data: 'goal_general' }]
      ]}});
      return;
    }
    if (data === 'diet_done') {
      user.diet_restrictions = session.dietSelections.join(', ') || '';
      DB.updateUser(user);
      session.step = 'goal';
      await ctx.answerCbQuery();
      await ctx.editMessageText(`✅ ${user.diet_restrictions || t(user, 'no_restrictions')}`);
      await ctx.reply(t(user, 'goal_q'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'goal_energy'), callback_data: 'goal_energy' }],
        [{ text: t(user, 'goal_longevity'), callback_data: 'goal_longevity' }],
        [{ text: t(user, 'goal_weight'), callback_data: 'goal_weight' }],
        [{ text: t(user, 'goal_general'), callback_data: 'goal_general' }]
      ]}});
      return;
    }
    const dietLabels = { diet_vegetarian: 'Vegetarian', diet_vegan: 'Vegan', diet_gf: 'Gluten-free', diet_lf: 'Lactose-free', diet_halal: 'Halal', diet_keto: 'Keto' };
    const label = dietLabels[data];
    if (label) {
      const idx = session.dietSelections.indexOf(label);
      if (idx >= 0) session.dietSelections.splice(idx, 1);
      else session.dietSelections.push(label);
      await ctx.answerCbQuery(`${idx >= 0 ? '❌' : '✅'} ${label}`);
    }
    return;
  }

  if ((data.startsWith('mp_') && data !== 'mp_menu') || data === 'meal_reroll') {
    if (!canUse(user, 'chat')) { await sendUpgradeInvoice(ctx, user); return; }
    user.chat_count++; DB.updateUser(user);

    const planTypes = {
      mp_balanced: { en: 'Balanced Diet', ru: 'Сбалансированное питание', hint: 'balanced macro split, variety of food groups' },
      mp_if16: { en: 'Intermittent Fasting 16:8', ru: 'Интервальное голодание 16:8', hint: 'eating window 12:00-20:00, 2-3 meals, no breakfast' },
      mp_keto: { en: 'Keto / Low-Carb', ru: 'Кето / Низкоуглеводная', hint: 'max 30g carbs/day, high fat, moderate protein' },
      mp_mediterranean: { en: 'Mediterranean Diet', ru: 'Средиземноморская диета', hint: 'olive oil, fish, whole grains, vegetables, fruits, nuts' },
      mp_muscle: { en: 'Muscle Gain', ru: 'Набор мышечной массы', hint: 'calorie surplus +300-500, high protein 2g/kg, 5-6 meals' },
      mp_cut: { en: 'Fat Loss', ru: 'Сушка / Дефицит калорий', hint: 'calorie deficit -500, high protein to preserve muscle, low fat' },
      mp_vegan: { en: 'Vegetarian/Vegan', ru: 'Вегетарианское / Веганское', hint: 'plant-based only, ensure B12, iron, complete proteins' },
      mp_longevity: { en: 'Anti-aging / Longevity', ru: 'Анти-эйдж / Долголетие', hint: 'anti-inflammatory, antioxidants, moderate calories, blue zone inspired' },
    };

    const planKey = data === 'meal_reroll' ? (session.lastPlanType || 'mp_balanced') : data;
    session.lastPlanType = planKey;
    const plan = planTypes[planKey] || planTypes.mp_balanced;

    DB.logEvent(ctx.from.id, 'MEAL_PLAN', planKey);
    user.has_meal_plan = 1;
    DB.updateUser(user);
    await ctx.answerCbQuery();
    await ctx.reply(t(user, 'meal_plan_gen'));

    const prompt = isPro(user) ? MEAL_PLAN_PROMPT_PRO : MEAL_PLAN_PROMPT_1DAY;
    const maxTok = isPro(user) ? 8000 : 3000;
    const extra = data === 'meal_reroll' ? ' Generate DIFFERENT dishes from the previous plan.' : '';

    try {
      const r = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: maxTok,
        messages: [{ role: 'system', content: prompt + TTS_RULE }, { role: 'user', content: `${plan.en} meal plan. Style: ${plan.hint}.${extra}${profileContext(user)}` }]
      });
      const planContent = r.choices[0].message.content;
      const sentPlan = await sendLong(ctx, planContent);
      await ctx.reply(t(user, 'what_next'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'another_variant'), callback_data: 'meal_reroll' }],
        [{ text: t(user, 'choose_diff_type'), callback_data: 'mp_menu' }]
      ]}});
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }

  if (data === 'mp_menu') {
    await ctx.answerCbQuery();
    await ctx.reply(t(user, 'choose_meal_type'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: mealPlanKeyboard(user) }
    });
    return;
  }

  if (data.startsWith('goal_')) {
    const goals = { goal_energy: 'Energy & Performance', goal_longevity: 'Longevity & Anti-aging', goal_weight: 'Weight Optimization', goal_general: 'General Health' };
    const goalKeys = { goal_energy: 'goal_energy', goal_longevity: 'goal_longevity', goal_weight: 'goal_weight', goal_general: 'goal_general' };
    user.goal = goals[data];
    DB.updateUser(user);
    session.step = 'ready';
    await ctx.answerCbQuery();
    const label = t(user, goalKeys[data]);
    await ctx.editMessageText(`✅ ${label}`);

    // Ensure referral code
    ensureReferralCode(user);

    // Profile done — offer trial if never used
    await ctx.reply(t(user, 'profile_done'), getMenu(user));
    if (!user.trial_used && !user.is_pro) {
      await ctx.reply(t(user, 'try_free'), {
        reply_markup: { inline_keyboard: [
          [{ text: t(user, 'try_pro_btn'), callback_data: 'activate_trial' }]
        ]}
      });
    }
  }

  // ─── Trial activation ───
  if (data === 'activate_trial') {
    await ctx.answerCbQuery();
    if (user.trial_used) {
      await ctx.editMessageText(t(user, 'trial_already_used'));
      return;
    }
    user.is_pro = 1;
    user.trial_expires = Date.now() + 24 * 60 * 60 * 1000;
    user.trial_used = 1;
    DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'TRIAL_ACTIVATED', '24h');
    const expiry = new Date(user.trial_expires).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    await ctx.editMessageText(t(user, 'trial_activated') + expiry, { parse_mode: 'Markdown' });
    return;
  }

  // ─── Food Diary callbacks ───
  if (data === 'food_diary_log') {
    session.awaitingImage = 'food_diary';
    await ctx.answerCbQuery();
    await ctx.reply(t(user, 'food_diary_send_photo'));
    return;
  }

  if (data === 'food_diary_summary') {
    await ctx.answerCbQuery();
    const entries = DB.getTodayFood(ctx.from.id);
    if (!entries.length) {
      await ctx.reply(t(user, 'food_diary_no_entries'));
      return;
    }
    const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    const items = [];
    for (const e of entries) {
      totals.calories += e.calories || 0;
      totals.protein += e.protein || 0;
      totals.carbs += e.carbs || 0;
      totals.fat += e.fat || 0;
      items.push(`• ${e.description} — ${e.calories} kcal`);
    }
    const msg = `📊 *${t(user, 'today_summary')}*\n\n${items.join('\n')}\n\n━━━━━━━━━━━━━━━━━━━━━\n🔥 ${t(user, 'calories')}: ${totals.calories} kcal\n🥩 ${t(user, 'protein')}: ${totals.protein.toFixed(1)}g\n🍞 ${t(user, 'carbs')}: ${totals.carbs.toFixed(1)}g\n🧈 ${t(user, 'fat')}: ${totals.fat.toFixed(1)}g`;
    await ctx.replyWithMarkdown(msg);
    return;
  }

  if (data === 'food_diary_history') {
    await ctx.answerCbQuery();
    const entries = DB.getRecentFood(ctx.from.id);
    if (!entries.length) {
      await ctx.reply(t(user, 'food_diary_no_entries'));
      return;
    }
    // Group by date
    const byDate = {};
    for (const e of entries) {
      const date = (e.created_at || '').slice(0, 10);
      if (!byDate[date]) byDate[date] = { entries: [], calories: 0 };
      byDate[date].entries.push(e);
      byDate[date].calories += e.calories || 0;
    }
    let msg = `📅 *${t(user, 'food_history')}*\n\n`;
    for (const [date, data] of Object.entries(byDate)) {
      msg += `*${date}* — ${data.calories} kcal (${data.entries.length} ${t(user, 'meals_word')})\n`;
      for (const e of data.entries) {
        msg += `  • ${e.description} — ${e.calories} kcal\n`;
      }
      msg += '\n';
    }
    await sendLong(ctx, msg);
    return;
  }

  // ─── Detox callbacks ───
  if (data === 'detox_start') {
    await ctx.answerCbQuery();
    DB.startDetox(ctx.from.id);
    DB.logEvent(ctx.from.id, 'DETOX_STARTED', '');
    await ctx.editMessageText(t(user, 'detox_started'), { parse_mode: 'Markdown' });
    // Show action buttons
    await ctx.reply(t(user, 'what_next'), { reply_markup: { inline_keyboard: [
      [{ text: t(user, 'detox_today_task'), callback_data: 'detox_task' }],
      [{ text: t(user, 'detox_complete_day'), callback_data: 'detox_complete' }]
    ]}});
    return;
  }

  if (data === 'detox_task') {
    await ctx.answerCbQuery();
    const detox = DB.getDetox(ctx.from.id);
    if (!detox) {
      await ctx.reply(t(user, 'detox_not_active'));
      return;
    }
    const completedArr = detox.completed_days ? detox.completed_days.split(',').filter(Boolean) : [];
    const currentDay = completedArr.length + 1;
    if (currentDay > 7) {
      await ctx.reply(t(user, 'detox_all_done'));
      return;
    }
    // Paywall: day 3+ requires Pro
    if (currentDay >= 3 && !isPro(user)) {
      await ctx.replyWithMarkdown(t(user, 'detox_pro_required'));
      return;
    }
    const themes = ['Hydration', 'Sugar-free', 'Green day', 'Anti-inflammatory', 'Gut health', 'Antioxidants', 'Integration'];
    const theme = themes[currentDay - 1];
    await ctx.reply(t(user, 'detox_generating'));
    try {
      const r = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 4000,
        messages: [
          { role: 'system', content: DETOX_PROMPT + TTS_RULE },
          { role: 'user', content: `Day ${currentDay} of 7-day detox. Theme: ${theme}.${profileContext(user)}` }
        ]
      });
      await sendLong(ctx, r.choices[0].message.content);
      await ctx.reply(t(user, 'when_done'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'detox_complete_day'), callback_data: 'detox_complete' }]
      ]}});
    } catch (e) {
      console.error('Detox error:', e?.message);
      await ctx.reply(t(user, 'error'));
    }
    return;
  }

  if (data === 'detox_complete') {
    await ctx.answerCbQuery();
    const detox = DB.getDetox(ctx.from.id);
    if (!detox) {
      await ctx.reply(t(user, 'detox_not_active'));
      return;
    }
    const completedArr = detox.completed_days ? detox.completed_days.split(',').filter(Boolean) : [];
    const currentDay = completedArr.length + 1;
    if (currentDay > 7) {
      await ctx.reply(t(user, 'detox_all_done'));
      return;
    }
    completedArr.push(String(currentDay));
    DB.updateDetox(ctx.from.id, currentDay, completedArr.join(','));
    DB.logEvent(ctx.from.id, 'DETOX_DAY_COMPLETE', `day ${currentDay}`);

    if (currentDay >= 7) {
      await ctx.replyWithMarkdown(t(user, 'detox_all_done'));
    } else {
      const msg = t(user, 'detox_day_completed').replace('DAYNUM', currentDay);
      await ctx.replyWithMarkdown(msg);
      const nextDay = currentDay + 1;
      if (nextDay >= 3 && !isPro(user)) {
        await ctx.replyWithMarkdown(t(user, 'detox_pro_required'));
      } else {
        await ctx.reply(`${t(user, 'tomorrow_day')} ${nextDay}!`, { reply_markup: { inline_keyboard: [
          [{ text: t(user, 'detox_today_task'), callback_data: 'detox_task' }]
        ]}});
      }
    }
    return;
  }

  // ─── Referral callback ───
  if (data === 'referral_show') {
    await ctx.answerCbQuery();
    const code = ensureReferralCode(user);
    const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
    const count = DB.countReferrals(user.id);
    await ctx.replyWithMarkdown(`${t(user, 'referral_title')}\n\n${t(user, 'referral_text')}${link}\n\n👥 ${t(user, 'referral_stats')}: ${count}`);
    return;
  }

  // ─── Change language ───
  if (data === 'change_lang') {
    await ctx.answerCbQuery();
    await ctx.reply(t(user, 'choose_lang'), { reply_markup: { inline_keyboard: langKeyboard() }});
    return;
  }
});

// ─── Photo ───
bot.on('photo', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);

  // Check trial
  if (checkTrialExpiry(user)) {
    await ctx.replyWithMarkdown(t(user, 'trial_expired'));
  }

  const mode = session.awaitingImage || 'analysis';
  session.awaitingImage = null;

  // Food diary mode — special handling
  if (mode === 'food_diary') {
    await ctx.reply(t(user, 'food_diary_analyzing'));
    try {
      const photos = ctx.message.photo;
      const base64 = await getImageBase64(ctx, photos[photos.length - 1].file_id);
      const caption = ctx.message.caption || '';

      // First get structured data for DB
      const jsonResponse = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 500,
        messages: [
          { role: 'system', content: FOOD_DIARY_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } },
            { type: 'text', text: caption || 'Analyze this meal.' }
          ]}
        ]
      });

      let parsed;
      try {
        let raw = jsonResponse.choices[0].message.content.trim();
        // Strip markdown code blocks if present
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = { description: 'Meal', calories: 0, protein: 0, carbs: 0, fat: 0 };
      }

      DB.addFoodEntry(ctx.from.id, parsed.description, parsed.calories || 0, parsed.protein || 0, parsed.carbs || 0, parsed.fat || 0);
      DB.logEvent(ctx.from.id, 'FOOD_DIARY', parsed.description);

      const pLbl = t(user, 'protein').charAt(0), cLbl = t(user, 'carbs').charAt(0), fLbl = t(user, 'fat').charAt(0);
      const msg = `${t(user, 'food_diary_logged')}\n\n🍽 *${parsed.description}*\n🔥 ${parsed.calories} kcal\n🥩 ${pLbl}: ${parsed.protein}g | 🍞 ${cLbl}: ${parsed.carbs}g | 🧈 ${fLbl}: ${parsed.fat}g`;
      await ctx.replyWithMarkdown(msg);

      // Also do full food analysis
      const fullResponse = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 4000,
        messages: [
          { role: 'system', content: FOOD_PROMPT + TTS_RULE },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
            { type: 'text', text: `${caption || 'Analyze this meal.'}${profileContext(user)}` }
          ]}
        ]
      });
      await sendLong(ctx, fullResponse.choices[0].message.content);
    } catch (e) {
      console.error('Food diary error:', e?.message);
      await ctx.reply(t(user, 'error'));
    }
    return;
  }

  if (!canUse(user, 'analysis')) { await sendUpgradeInvoice(ctx, user); return; }

  const prompts = { document: DOC_PROMPT, food: FOOD_PROMPT, analysis: ANALYSIS_PROMPT };
  const prompt = prompts[mode] || ANALYSIS_PROMPT;

  const labelKeys = { document: 'interpreting', food: 'scanning_food', analysis: 'analyzing' };
  await ctx.reply(t(user, labelKeys[mode] || 'analyzing'));

  try {
    const photos = ctx.message.photo;
    const base64 = await getImageBase64(ctx, photos[photos.length - 1].file_id);
    const caption = ctx.message.caption || '';

    const response = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 4000,
      messages: [
        { role: 'system', content: prompt + TTS_RULE },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
          { type: 'text', text: `${caption || 'Analyze this.'}${profileContext(user)}` }
        ]}
      ]
    });

    user.analysis_count++;
    DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'ANALYSIS', `#${user.analysis_count}`);
    await sendLong(ctx, response.choices[0].message.content);

    const rem = FREE_ANALYSIS_LIMIT - user.analysis_count;
    if (!isPro(user)) {
      if (rem > 0) await ctx.reply(`📊 Free analyses remaining: ${rem}/${FREE_ANALYSIS_LIMIT}`);
      else await ctx.replyWithMarkdown(`📊 Last free analysis used.\n👉 [Upgrade — $19/mo](${CHECKOUT_URL})`);
    }
  } catch (e) {
    console.error('Analysis error:', e?.message);
    await ctx.reply('❌ Error. Try again or send a clearer photo.');
  }
});

// ─── Document ───
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (doc.mime_type && doc.mime_type.startsWith('image/')) {
    const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    if (!canUse(user, 'analysis')) { await sendUpgradeInvoice(ctx, user); return; }
    await ctx.reply('🔬 Analyzing...');
    try {
      const base64 = await getImageBase64(ctx, doc.file_id);
      const response = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 4000,
        messages: [
          { role: 'system', content: ANALYSIS_PROMPT + TTS_RULE },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
            { type: 'text', text: `Analyze.${profileContext(user)}` }
          ]}
        ]
      });
      user.analysis_count++;
      DB.updateUser(user);
      DB.logEvent(ctx.from.id, 'ANALYSIS', `#${user.analysis_count} (doc)`);
      await sendLong(ctx, response.choices[0].message.content);
    } catch (e) {
      console.error('Doc error:', e?.message);
      await ctx.reply('❌ Error. Send as photo instead.');
    }
  } else {
    await ctx.reply('📄 Send medical documents as photos (JPG/PNG).');
  }
});

// ─── Voice (STT via Whisper) ───
bot.on('voice', async (ctx) => {
  if (!ttsClient) return;
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);

  try {
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());
    const tmpPath = path.join(os.tmpdir(), `voice_${ctx.from.id}_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);

    const transcript = await ttsClient.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpPath),
    });

    fs.unlinkSync(tmpPath);

    const text = transcript.text?.trim();
    if (!text) {
      await ctx.reply('🤷 Could not recognize speech');
      return;
    }

    await ctx.replyWithMarkdown(`🎤 _${text}_`);

    // Process as regular text via AI chat
    if (!canUse(user, 'chat')) { await sendUpgradeInvoice(ctx, user); return; }
    user.chat_count++; DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'VOICE_CHAT', text.slice(0, 100));

    const session = getSession(ctx.from.id);
    session.history.push({ role: 'user', content: text });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    const r = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 5000,
      messages: [{ role: 'system', content: CHAT_PROMPT + TTS_RULE + `\nCRITICAL: Always respond in ${LANG_FULL[user.lang] || 'the same language the user writes in'}. Never switch languages.` + (isPro(user) ? '' : '\nUser is on FREE plan. Limit meal/diet plans to 1 day only. Always end meal plans with: "🔒 *Full 7-day plan + shopping list → Pro*"') + profileContext(user) }, ...session.history]
    });
    const reply = r.choices[0].message.content;
    session.history.push({ role: 'assistant', content: reply });
    await sendLong(ctx, reply);
  } catch (e) {
    console.error('Voice error:', e?.message);
    await ctx.reply('❌ Voice processing error');
  }
});

// ─── Text ───
bot.on('text', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);
  const rawText = ctx.message.text.trim();
  const text = MENU_TO_CMD[rawText] || rawText;

  // Check trial on every text
  if (checkTrialExpiry(user)) {
    await ctx.replyWithMarkdown(t(user, 'trial_expired'));
  }

  // Onboarding: age
  if (session.step === 'age') {
    const age = parseInt(text);
    if (age > 0 && age < 120) {
      user.age = age;
      DB.updateUser(user);
      session.step = 'height';
      await ctx.reply(`✅ ${age}\n\n${t(user, 'height_q')}`);
    } else {
      await ctx.reply(t(user, 'valid_age'));
    }
    return;
  }

  if (session.step === 'height') {
    const h = parseInt(text);
    if (h > 50 && h < 300) {
      user.height = h;
      DB.updateUser(user);
      session.step = 'weight';
      await ctx.reply(`✅ ${h} ${t(user, 'cm')}\n\n${t(user, 'weight_q')}`);
    } else {
      await ctx.reply(t(user, 'valid_height'));
    }
    return;
  }

  if (session.step === 'weight') {
    const w = parseFloat(text);
    if (w > 20 && w < 500) {
      user.weight = w;
      DB.updateUser(user);
      session.step = 'activity';
      await ctx.reply(`✅ ${w} ${t(user, 'kg')}\n\n${t(user, 'activity_q')}`, { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'activity_low'), callback_data: 'act_low' }],
        [{ text: t(user, 'activity_moderate'), callback_data: 'act_moderate' }],
        [{ text: t(user, 'activity_high'), callback_data: 'act_high' }],
        [{ text: t(user, 'activity_athlete'), callback_data: 'act_athlete' }]
      ]}});
    } else {
      await ctx.reply(t(user, 'valid_weight'));
    }
    return;
  }

  // Symptom input
  if (session.awaitingSymptoms) {
    session.awaitingSymptoms = false;
    if (!canUse(user, 'chat')) { await sendUpgradeInvoice(ctx, user); return; }
    user.chat_count++;
    DB.updateUser(user);
    DB.addSymptom(ctx.from.id, text);
    DB.logEvent(ctx.from.id, 'SYMPTOM', text.slice(0, 100));
    await ctx.reply('🔍 Analyzing symptoms...');
    try {
      const symptoms = DB.getSymptoms(ctx.from.id).map(s => `${s.created_at}: ${s.text}`).join('\n');
      const response = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 4000,
        messages: [
          { role: 'system', content: SYMPTOM_PROMPT + TTS_RULE },
          { role: 'user', content: `${profileContext(user)}\n\nSymptom history:\n${symptoms}\n\nLatest: ${text}` }
        ]
      });
      await sendLong(ctx, response.choices[0].message.content);
    } catch (e) {
      console.error('Symptom error:', e?.message);
      await ctx.reply('❌ Error. Try again.');
    }
    return;
  }

  // ─── Menu handlers ───
  if (text === '🔬 Analyze Blood Test') {
    session.awaitingImage = 'analysis';
    await ctx.reply(t(user, 'send_blood'));
    return;
  }
  if (text === '📸 Scan Food') {
    session.awaitingImage = 'food';
    await ctx.reply(t(user, 'send_food'));
    return;
  }
  if (text === '🥗 Meal Plan') {
    await ctx.reply(t(user, 'choose_meal_type'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: mealPlanKeyboard(user) }
    });
    return;
  }
  if (text === '💊 Supplement Protocol') {
    if (!canUse(user, 'chat')) { await sendUpgradeInvoice(ctx, user); return; }
    user.chat_count++; DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'SUPPLEMENT', '');
    await ctx.reply(t(user, 'supplement_gen'));
    try {
      const r = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 5000,
        messages: [{ role: 'system', content: SUPPLEMENT_PROMPT + TTS_RULE }, { role: 'user', content: `Supplements.${profileContext(user)}` }]
      });
      await sendLong(ctx, r.choices[0].message.content);
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }
  if (text === '⏰ Meal Reminders') {
    if (!user.goal || !user.has_meal_plan) {
      const msg = !user.goal ? t(user, 'reminders_after_profile') : t(user, 'reminders_after_plan');
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      return;
    }
    if (reminders[ctx.from.id] && reminders[ctx.from.id].length > 0) {
      const r = reminders[ctx.from.id];
      const schedule = r.map(m => `⏰ ${m.localTime} — ${m.meal}`).join('\n');
      await ctx.reply(`🍽 *${t(user, 'your_reminders')}:*\n\n${schedule}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: t(user, 'remind_change'), callback_data: 'remind_setup' }],
        [{ text: t(user, 'remind_turn_off'), callback_data: 'remind_off' }]
      ]}});
    } else {
      await ctx.reply(`⏰ *${t(user, 'meal_reminders_title')}*\n\n${t(user, 'remind_intro')}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🇬🇪 Tbilisi +4', callback_data: 'tz_4' }, { text: '🇦🇪 Dubai +4', callback_data: 'tz_4' }],
        [{ text: '🇹🇷 Istanbul +3', callback_data: 'tz_3' }, { text: '🇪🇺 Berlin +1', callback_data: 'tz_1' }],
        [{ text: '🇬🇧 London 0', callback_data: 'tz_0' }, { text: '🇺🇸 NY -5', callback_data: 'tz_-5' }],
        [{ text: '🇺🇸 LA -8', callback_data: 'tz_-8' }, { text: '🇷🇺 Moscow +3', callback_data: 'tz_3' }]
      ]}});
    }
    return;
  }
  if (text === '📋 Track Symptoms') {
    session.awaitingSymptoms = true;
    await ctx.reply(t(user, 'symptom_q'));
    return;
  }
  if (text === '📄 Interpret Document') {
    session.awaitingImage = 'document';
    await ctx.reply(t(user, 'send_doc'));
    return;
  }
  if (text === '💬 Health Chat') {
    await ctx.reply(t(user, 'chat_ask'));
    return;
  }

  // ─── Food Diary menu ───
  if (text === '📔 Food Diary') {
    await ctx.reply(t(user, 'food_diary_title'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: t(user, 'food_diary_log'), callback_data: 'food_diary_log' }],
        [{ text: t(user, 'food_diary_summary'), callback_data: 'food_diary_summary' }],
        [{ text: t(user, 'food_diary_history'), callback_data: 'food_diary_history' }]
      ]}
    });
    return;
  }

  // ─── Detox Program menu ───
  if (text === '🧹 Detox Program') {
    const detox = DB.getDetox(ctx.from.id);
    if (detox) {
      const completedArr = detox.completed_days ? detox.completed_days.split(',').filter(Boolean) : [];
      const currentDay = Math.min(completedArr.length + 1, 7);
      const status = t(user, 'detox_status').replace('CURRENT', currentDay).replace('COMPLETED', completedArr.length);
      await ctx.reply(`${t(user, 'detox_title')}\n\n📊 ${status}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: t(user, 'detox_today_task'), callback_data: 'detox_task' }],
          [{ text: t(user, 'detox_complete_day'), callback_data: 'detox_complete' }],
          [{ text: t(user, 'detox_restart'), callback_data: 'detox_start' }]
        ]}
      });
    } else {
      await ctx.reply(`${t(user, 'detox_title')}\n\n${t(user, 'detox_desc')}\n\n${!isPro(user) ? t(user, 'detox_free_note') : ''}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: t(user, 'detox_start'), callback_data: 'detox_start' }]
        ]}
      });
    }
    return;
  }

  if (text === '⭐ Upgrade to Pro') {
    await sendUpgradeInvoice(ctx, user);
    return;
  }

  if (text === '👤 My Profile') {
    const refCount = DB.countReferrals(user.id);
    const code = ensureReferralCode(user);
    const trialInfo = user.trial_expires && user.trial_expires > Date.now()
      ? `\n⏰ ${t(user, 'trial_until')}: ${new Date(user.trial_expires).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : '';
    await ctx.replyWithMarkdown([
      `👤 *${t(user, 'your_profile')}*`,
      `${t(user, 'sex')}: ${user.gender || t(user, 'not_set')}`,
      user.pregnancy_status && user.pregnancy_status !== 'not pregnant' ? `${t(user, 'status_label')}: ${user.pregnancy_status}` : null,
      `${t(user, 'age_label')}: ${user.age || t(user, 'not_set')}`,
      `${t(user, 'height_label')}: ${user.height ? user.height + ' ' + t(user, 'cm') : t(user, 'not_set')}`,
      `${t(user, 'weight_label')}: ${user.weight ? user.weight + ' ' + t(user, 'kg') : t(user, 'not_set')}`,
      `${t(user, 'activity_label')}: ${user.activity_level || t(user, 'not_set')}`,
      `${t(user, 'diet_label')}: ${user.diet_restrictions || t(user, 'none')}`,
      `${t(user, 'goal_label')}: ${user.goal || t(user, 'not_set')}`,
      `\n📊 *${t(user, 'usage')}*`,
      `${t(user, 'analyses')}: ${user.analysis_count}/${isPro(user) ? '∞' : FREE_ANALYSIS_LIMIT}`,
      `${t(user, 'chats')}: ${user.chat_count}/${isPro(user) ? '∞' : FREE_CHAT_LIMIT}`,
      `\n👥 ${t(user, 'referral_stats')}: ${refCount}`,
      trialInfo,
      `\n${isPro(user) ? `⭐ *${t(user, 'pro_member')}*` : `💎 Нажмите "Pro подписка" для апгрейда`}`
    ].filter(Boolean).join('\n'));

    // Show referral + change language buttons under profile
    await ctx.reply(t(user, 'actions'), { reply_markup: { inline_keyboard: [
      [{ text: t(user, 'referral_btn'), callback_data: 'referral_show' }],
      [{ text: t(user, 'change_lang'), callback_data: 'change_lang' }]
    ]}});
    return;
  }
  if (text.includes('Pro') && text.includes('⭐')) {
    DB.logEvent(ctx.from.id, 'UPGRADE_CLICK', '');
    await sendUpgradeInvoice(ctx, user);
    return;
  }

  // ─── General chat ───
  if (!canUse(user, 'chat')) { await sendUpgradeInvoice(ctx, user); return; }
  user.chat_count++; DB.updateUser(user);
  DB.logEvent(ctx.from.id, 'CHAT', text.slice(0, 100));

  try {
    session.history.push({ role: 'user', content: text });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    const r = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 5000,
      messages: [{ role: 'system', content: CHAT_PROMPT + TTS_RULE + `\nCRITICAL: Always respond in ${LANG_FULL[user.lang] || 'the same language the user writes in'}. Never switch languages.` + (isPro(user) ? '' : '\nUser is on FREE plan. Limit meal/diet plans to 1 day only. Always end meal plans with: "🔒 *Full 7-day plan + shopping list → Pro*"') + profileContext(user) }, ...session.history]
    });
    const reply = r.choices[0].message.content;
    session.history.push({ role: 'assistant', content: reply });
    const sent = await sendLong(ctx, reply);
  } catch (e) {
    console.error('Chat error:', e?.message);
    await ctx.reply('❌ Error. Try again.');
  }
});

// ─── Webhook server for Paddle ───
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook/paddle') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        // Verify Paddle webhook signature
        if (PADDLE_WEBHOOK_SECRET) {
          const crypto = require('crypto');
          const sig = req.headers['paddle-signature'] || '';
          const parts = Object.fromEntries(sig.split(';').map(p => p.split('=')));
          const ts = parts['ts'] || '';
          const h1 = parts['h1'] || '';
          const payload = `${ts}:${body}`;
          const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(payload).digest('hex');
          if (!h1 || !crypto.timingSafeEqual(Buffer.from(h1), Buffer.from(expected))) {
            console.error('Paddle webhook: INVALID SIGNATURE');
            res.writeHead(401);
            res.end('Invalid signature');
            return;
          }
        } else {
          console.warn('Paddle webhook: PADDLE_WEBHOOK_SECRET not set — accepting without verification');
        }

        const data = JSON.parse(body);
        const eventType = data.event_type;
        const customData = data.data?.custom_data || {};
        const telegramId = customData.telegram_id;
        const email = data.data?.customer?.email || '';

        console.log(`Paddle webhook: ${eventType} | email: ${email} | tg: ${telegramId}`);
        DB.logEvent(telegramId || 0, 'PADDLE_WEBHOOK', `${eventType} | ${email}`);

        if (eventType === 'subscription.activated' || eventType === 'subscription.created' || eventType === 'transaction.completed') {
          if (telegramId) {
            const user = DB.getUser(parseInt(telegramId));
            if (user) {
              user.is_pro = 1;
              user.trial_expires = 0;
              DB.updateUser(user);
              DB.logEvent(telegramId, 'PRO_ACTIVATED', email);
              const ru = user.lang === 'ru';
              bot.telegram.sendMessage(telegramId, 
                ru ? '🎉 *Добро пожаловать в Metabolic Center Pro!*\n\nУ вас теперь безлимитный доступ ко всем функциям!' 
                   : '🎉 *Welcome to Metabolic Center Pro!*\n\nYou now have unlimited access to all features. Enjoy!', 
                { parse_mode: 'Markdown' }
              ).catch(console.error);
            }
          }
        }

        if (eventType === 'subscription.canceled' || eventType === 'subscription.past_due') {
          if (telegramId) {
            const user = DB.getUser(parseInt(telegramId));
            if (user) {
              user.is_pro = 0;
              DB.updateUser(user);
              DB.logEvent(telegramId, 'PRO_DEACTIVATED', email);
            }
          }
        }

        res.writeHead(200);
        res.end('OK');
      } catch (e) {
        console.error('Webhook error:', e);
        res.writeHead(500);
        res.end('Error');
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`Webhook server on port ${PORT}`));

// ─── Stars Payment Handlers ───
bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const uid = ctx.from.id;
  console.log(`Payment: user=${uid}, amount=${payment.total_amount} XTR, payload=${payment.invoice_payload}`);

  // Activate Pro for 30 days
  const user = getUser(uid);
  user.is_pro = 1;
  user.trial_expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  saveUser(uid, user);

  const lang = user.lang || 'en';
  const txt = lang === 'ru'
    ? `🎉 <b>Pro подписка активирована!</b>\n\nДоступ на 30 дней.\n\n✦ Безлимитный анализ крови\n✦ Персональные планы питания\n✦ AI чат по здоровью\n✦ Трекинг симптомов\n\nПользуйтесь! ✨`
    : `🎉 <b>Pro activated!</b>\n\n30 days unlimited access.\n\nEnjoy! ✨`;
  await ctx.replyWithHTML(txt);
});

// ─── Launch ───
bot.catch((err) => console.error('Bot error:', err));
bot.launch().then(() => {
  console.log('🧬 Metabolic Center Bot is running!');
  startReminderLoop();
  startDailySummaryLoop();
  startDetoxReminderLoop();
  console.log('⏰ All loops started (reminders, food diary summary, detox reminders)');
});
process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
