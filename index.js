const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const DB = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
if (!BOT_TOKEN || !OPENAI_KEY) { console.error('Set BOT_TOKEN and OPENAI_KEY'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ─── Config ───
const FREE_ANALYSIS_LIMIT = 2;
const FREE_CHAT_LIMIT = 10;
const CHECKOUT_URL = 'https://metaboliccenter.lemonsqueezy.com/checkout/buy/748aab66-5a40-492a-91f6-cda2f844723c';
const ADMIN_ID = 5309206282;

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
          const ru = rUser?.lang === 'ru';
          const mealRu = { Breakfast: 'Завтрак', Lunch: 'Обед', Dinner: 'Ужин', Snack: 'Перекус' };
          const mealName = ru ? (mealRu[r.meal] || r.meal) : r.meal;
          const footer = ru ? '_Приятного аппетита! Отправьте фото еды — я её проанализирую._' : '_Bon appétit! Reply with a food photo and I\'ll scan it._';
          bot.telegram.sendMessage(userId, 
            `⏰ *${ru ? 'Напоминание' : 'Meal Reminder'}: ${mealName}*\n\n${r.text}\n\n${footer}`,
            { parse_mode: 'Markdown' }
          ).catch(console.error);
          r.sentToday = true;
          // Reset next minute
          setTimeout(() => { r.sentToday = false; }, 120000);
        }
      }
    }
  }, 60000); // Check every minute
}


// ─── Translations ───
const i18n = {
  en: {
    welcome: `🧬 *Welcome to Metabolic Center*\n\nYour AI Metabolic Intelligence assistant.\n\n🔬 *Analyze Blood Tests* — full metabolic report from a photo\n📸 *Scan Food* — photo your meal, get calories & metabolic score\n🥗 *Meal Plan* — personalized nutrition\n💊 *Supplement Protocol* — evidence-based stack\n📋 *Track Symptoms* — detect patterns\n📄 *Interpret Documents* — explain any medical doc\n💬 *Health Chat* — ask anything\n\n📸 *2 free analyses + 10 free chats to start!*`,
    choose_lang: '🌐 Choose your language:',
    sex_q: 'Let me set up your profile.\n\n👤 Biological sex?',
    male: '♂️ Male', female: '♀️ Female',
    pregnant_q: '🤰 Are you pregnant or breastfeeding?',
    preg_yes: '🤰 Pregnant', preg_bf: '🤱 Breastfeeding', preg_no: '❌ No',
    age_q: '📅 Your age? (type a number)',
    height_q: '📏 Your height in cm? (e.g. 175)',
    weight_q: '⚖️ Your weight in kg? (e.g. 80)',
    activity_q: '🏃 Your activity level?',
    activity_low: '🧘 Low (sedentary)',
    activity_moderate: '🚶 Moderate (3-4x/week)',
    activity_high: '🏋️ High (5-7x/week)',
    activity_athlete: '🏅 Athlete (2x/day)',
    diet_q: '🍽 Any dietary restrictions? (pick all that apply, then press Done)',
    diet_none: '✅ No restrictions',
    diet_vegetarian: '🥬 Vegetarian',
    diet_vegan: '🌱 Vegan',
    diet_gluten_free: '🚫🌾 Gluten-free',
    diet_lactose_free: '🚫🥛 Lactose-free',
    diet_halal: '☪️ Halal',
    diet_keto: '🥑 Keto',
    diet_done: '✅ Done',
    goal_q: '🎯 Primary goal?',
    goal_energy: '⚡ Energy & Performance', goal_longevity: '🧬 Longevity', goal_weight: '⚖️ Weight', goal_general: '💚 General Health',
    profile_done: '✅ Profile complete! Use the menu below 👇',
    analyzing: '🔬 Analyzing... (30-60 sec)',
    scanning_food: '📸 Scanning your meal...',
    interpreting: '📄 Interpreting...',
    send_blood: '📸 Send a photo of your blood test results.',
    send_food: '📸 Send a photo of your meal.',
    send_doc: '📄 Send a photo of your medical document.',
    meal_plan_gen: '🥗 Generating meal plan...',
    supplement_gen: '💊 Building protocol...',
    symptom_q: '📋 Describe your symptoms:',
    symptom_analyzing: '🔍 Analyzing symptoms...',
    chat_ask: '💬 Ask me anything about health!',
    free_remaining: (n, t) => `📊 Free analyses remaining: ${n}/${t}`,
    last_free: 'That was your last free analysis.',
    upgrade_btn: '⭐ Upgrade to Pro',
    error: '❌ Error. Try again.',
    remind_tz: '⏰ *Meal Reminders*\n\nChoose your timezone:',
    remind_schedule: 'Choose your eating schedule:',
    remind_early: '🌅 Early Bird (7-12-15-18)',
    remind_standard: '☀️ Standard (8-13-16-19)',
    remind_late: '🌙 Late Riser (10-14-17-21)',
    remind_if: '🔥 IF 16:8 (12-15-19)',
    remind_set: '✅ *Schedule set!*',
    remind_off: '⏰ Reminders turned off.',
    remind_change: '🔄 Change schedule',
    remind_turn_off: '❌ Turn off reminders',
    breakfast_tip: 'Protein smoothie, eggs, or oatmeal with fruits.',
    lunch_tip: 'Balanced plate: protein + veggies + healthy carbs.',
    snack_tip: 'Handful of nuts, fruit, or protein bar.',
    dinner_tip: 'Lean protein + vegetables. Finish eating 3h before sleep.',
  },
  ru: {
    welcome: `🧬 *Добро пожаловать в Metabolic Center*\n\nВаш AI-ассистент метаболического здоровья.\n\n🔬 *Анализ крови* — полный отчёт по фото\n📸 *Сканер еды* — фото блюда → калории и оценка\n🥗 *План питания* — персональное меню\n💊 *Протокол добавок* — подбор добавок\n📋 *Трекер симптомов* — отслеживание паттернов\n📄 *Расшифровка документов* — объяснение мед. документов\n💬 *Чат о здоровье* — любые вопросы\n\n📸 *2 бесплатных анализа + 10 чатов!*`,
    choose_lang: '🌐 Выберите язык:',
    sex_q: 'Настроим ваш профиль.\n\n👤 Ваш пол?',
    male: '♂️ Мужской', female: '♀️ Женский',
    pregnant_q: '🤰 Вы беременны или кормите грудью?',
    preg_yes: '🤰 Беременна', preg_bf: '🤱 Кормлю грудью', preg_no: '❌ Нет',
    age_q: '📅 Ваш возраст? (введите число)',
    height_q: '📏 Ваш рост в см? (например 175)',
    weight_q: '⚖️ Ваш вес в кг? (например 80)',
    activity_q: '🏃 Уровень активности?',
    activity_low: '🧘 Низкий (сидячий образ жизни)',
    activity_moderate: '🚶 Средний (3-4 раза/нед)',
    activity_high: '🏋️ Высокий (5-7 раз/нед)',
    activity_athlete: '🏅 Атлет (2 раза/день)',
    diet_q: '🍽 Есть ограничения в питании? (выберите все подходящие, потом нажмите Готово)',
    diet_none: '✅ Нет ограничений',
    diet_vegetarian: '🥬 Вегетарианство',
    diet_vegan: '🌱 Веганство',
    diet_gluten_free: '🚫🌾 Без глютена',
    diet_lactose_free: '🚫🥛 Без лактозы',
    diet_halal: '☪️ Халяль',
    diet_keto: '🥑 Кето',
    diet_done: '✅ Готово',
    goal_q: '🎯 Главная цель?',
    goal_energy: '⚡ Энергия', goal_longevity: '🧬 Долголетие', goal_weight: '⚖️ Вес', goal_general: '💚 Общее здоровье',
    profile_done: '✅ Профиль готов! Используйте меню 👇',
    analyzing: '🔬 Анализирую... (30-60 сек)',
    scanning_food: '📸 Сканирую блюдо...',
    interpreting: '📄 Расшифровываю...',
    send_blood: '📸 Отправьте фото анализа крови.',
    send_food: '📸 Отправьте фото вашего блюда.',
    send_doc: '📄 Отправьте фото медицинского документа.',
    meal_plan_gen: '🥗 Составляю план питания...',
    supplement_gen: '💊 Подбираю добавки...',
    symptom_q: '📋 Опишите симптомы:',
    symptom_analyzing: '🔍 Анализирую симптомы...',
    chat_ask: '💬 Спрашивайте что угодно о здоровье!',
    free_remaining: (n, t) => `📊 Осталось бесплатных анализов: ${n}/${t}`,
    last_free: 'Это был последний бесплатный анализ.',
    upgrade_btn: '⭐ Перейти на Pro',
    error: '❌ Ошибка. Попробуйте снова.',
    remind_tz: '⏰ *Напоминания о еде*\n\nВыберите часовой пояс:',
    remind_schedule: 'Выберите расписание:',
    remind_early: '🌅 Ранний (7-12-15-18)',
    remind_standard: '☀️ Обычный (8-13-16-19)',
    remind_late: '🌙 Поздний (10-14-17-21)',
    remind_if: '🔥 ИП 16:8 (12-15-19)',
    remind_set: '✅ *Расписание установлено!*',
    remind_off: '⏰ Напоминания отключены.',
    remind_change: '🔄 Изменить расписание',
    remind_turn_off: '❌ Отключить напоминания',
    breakfast_tip: 'Белковый завтрак: яйца, каша с ягодами, или смузи.',
    lunch_tip: 'Сбалансированный обед: белок + овощи + сложные углеводы.',
    snack_tip: 'Перекус: орехи, фрукты или йогурт.',
    dinner_tip: 'Лёгкий ужин: белок + овощи. Не позже чем за 3ч до сна.',
  }
};

function t(user, key, ...args) {
  const lang = user?.lang || 'en';
  const val = i18n[lang]?.[key] || i18n.en[key] || key;
  return typeof val === 'function' ? val(...args) : val;
}

// In-memory session state
const sessions = {};
function getSession(id) {
  if (!sessions[id]) sessions[id] = { step: null, history: [], awaitingImage: null, awaitingSymptoms: false };
  return sessions[id];
}

const UPGRADE_MSG = `🔒 *Free limit reached*

Upgrade to Metabolic Center Pro:

✦ Unlimited blood test analyses
✦ Unlimited AI health chat
✦ Personalized meal plans & supplement protocols
✦ Symptom tracking & pattern detection
✦ Medical document interpretation

💰 *Founding price: $19/mo* (locked forever)
_Future price: $79/mo_

👉 [Upgrade Now](${CHECKOUT_URL})`;

// ─── Prompts ───
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

const CHAT_PROMPT = `You are the Metabolic Center AI — a premium health intelligence assistant.
You help with: metabolic health, nutrition, supplements, sleep, exercise, biomarkers, longevity.
Be concise, evidence-based, actionable.

FORMATTING RULES (always follow):
- Use emojis for structure (🍳🥗🍽💊📊✅⚠️ etc.)
- Use *bold* for headings and key info
- Use bullet points (•) for lists
- Include calories and macros when discussing food/meals
- If user asks for a meal plan, use the same premium format:
  📊 *Daily Target: XXXXkcal | P: XXXg | C: XXXg | F: XXXg*
  Then each meal with emoji, time, calories, portions in grams
- Make responses look premium and polished — you are a $19/mo service

End health advice with: "This is AI-generated guidance, not medical advice."

`;

const MEAL_PLAN_PROMPT_1DAY = `You are a precision nutrition AI for Metabolic Center.
Generate a detailed 1-DAY personalized meal plan.

FORMAT (use this exact structure with emojis):
━━━━━━━━━━━━━━━━━━━━━
📊 *Daily Target: XXXXkcal | P: XXXg | C: XXXg | F: XXXg*
━━━━━━━━━━━━━━━━━━━━━

🌅 *Breakfast (XX:XX)* — XXX kcal
• [dish with portion] — P/C/F

🥗 *Lunch (XX:XX)* — XXX kcal
• [dish with portion] — P/C/F

🥜 *Snack (XX:XX)* — XXX kcal
• [dish with portion] — P/C/F

🍽 *Dinner (XX:XX)* — XXX kcal
• [dish with portion] — P/C/F

💧 *Hydration:* X liters water/day
🚫 *Avoid:* [list based on goal]

At the end add: "🔒 *Full 7-day plan + shopping list → Pro*"

RULES:
- Calculate calories based on profile (weight, height, age, activity, goal)
- Respect ALL dietary restrictions
- Be specific with portions (grams)
- Keep it practical — real dishes, easy to cook`;

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

const DOC_PROMPT = `You are a medical document interpreter for Metabolic Center.
Explain findings in simple language, highlight abnormalities, connect to metabolic health.
End with: "AI interpretation. Discuss results with your doctor."`;

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
  const lang = (user?.lang === 'ru') ? 'Russian' : 'English';
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

async function sendLong(ctx, text) {
  if (text.length > 4000) {
    for (const p of text.match(/[\s\S]{1,4000}/g)) await ctx.replyWithMarkdown(p).catch(() => ctx.reply(p));
  } else {
    await ctx.replyWithMarkdown(text).catch(() => ctx.reply(text));
  }
}

function canUse(user, type) {
  if (user.is_pro) return true;
  if (type === 'analysis') return user.analysis_count < FREE_ANALYSIS_LIMIT;
  if (type === 'chat') return user.chat_count < FREE_CHAT_LIMIT;
  return true;
}

// ─── Menu ───
const MENU_EN = [
  ['🔬 Analyze Blood Test', '📸 Scan Food'],
  ['🥗 Meal Plan', '💊 Supplement Protocol'],
  ['📋 Track Symptoms', '📄 Interpret Document'],
  ['⏰ Meal Reminders', '💬 Health Chat'],
  ['👤 My Profile', '⭐ Upgrade to Pro']
];
const MENU_RU = [
  ['🔬 Анализ крови', '📸 Сканер еды'],
  ['🥗 План питания', '💊 Протокол добавок'],
  ['📋 Симптомы', '📄 Расшифровка'],
  ['⏰ Напоминания', '💬 Чат со специалистом'],
  ['👤 Мой профиль', '⭐ Pro подписка']
];
const MAIN_MENU = Markup.keyboard(MENU_EN).resize();
function getMenu(user) {
  const rows = (user?.lang === 'ru') ? MENU_RU : MENU_EN;
  return Markup.keyboard(rows).resize();
}
// Map Russian menu buttons to English equivalents for handler matching
const RU_TO_CMD = {
  '🔬 Анализ крови': '🔬 Analyze Blood Test',
  '📸 Сканер еды': '📸 Scan Food',
  '🥗 План питания': '🥗 Meal Plan',
  '💊 Протокол добавок': '💊 Supplement Protocol',
  '📋 Симптомы': '📋 Track Symptoms',
  '📄 Расшифровка': '📄 Interpret Document',
  '⏰ Напоминания': '⏰ Meal Reminders',
  '💬 Чат со специалистом': '💬 Health Chat',
  '👤 Мой профиль': '👤 My Profile',
  '⭐ Pro подписка': '⭐ Upgrade to Pro'
};

const WELCOME = `🧬 *Welcome to Metabolic Center*

Your AI Metabolic Intelligence assistant.

🔬 *Analyze Blood Tests* — full metabolic report from a photo
📸 *Scan Food* — photo your meal, get calories & metabolic score
🥗 *Meal Plan* — personalized nutrition
💊 *Supplement Protocol* — evidence-based stack
📋 *Track Symptoms* — detect patterns
📄 *Interpret Documents* — explain any medical doc
💬 *Health Chat* — ask anything

📸 *2 free analyses + 10 free chats to start!*`;

// ─── Commands ───
bot.start(async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);
  session.step = 'lang';
  DB.logEvent(ctx.from.id, 'START', `@${ctx.from.username || ''} ${ctx.from.first_name || ''}`);
  
  // Auto-detect language from Telegram
  const tgLang = ctx.from.language_code || '';
  if (tgLang.startsWith('ru')) {
    user.lang = 'ru';
    DB.updateUser(user);
    session.step = 'gender';
    await ctx.replyWithMarkdown(t(user, 'welcome'), getMenu(user));
    setTimeout(() => {
      ctx.reply(t(user, 'sex_q'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'male'), callback_data: 'gender_male' }, { text: t(user, 'female'), callback_data: 'gender_female' }]
      ]}});
    }, 1000);
  } else {
    await ctx.reply('🌐 Choose your language:', { reply_markup: { inline_keyboard: [
      [{ text: '🇺🇸 English', callback_data: 'lang_en' }],
      [{ text: '🇷🇺 Русский', callback_data: 'lang_ru' }]
    ]}});
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

// Admin: deactivate Pro
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

  if (data.startsWith('lang_')) {
    user.lang = data.replace('lang_', '');
    DB.updateUser(user);
    const session = getSession(ctx.from.id);
    session.step = 'gender';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ ${user.lang === 'ru' ? 'Русский' : 'English'}`);
    await ctx.replyWithMarkdown(t(user, 'welcome'), getMenu(user));
    setTimeout(() => {
      ctx.reply(t(user, 'sex_q'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'male'), callback_data: 'gender_male' }, { text: t(user, 'female'), callback_data: 'gender_female' }]
      ]}});
    }, 1000);
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
    const ru = user.lang === 'ru';
    await ctx.editMessageText(`✅ *${ru ? 'Расписание установлено!' : 'Schedule set!'}*\n\n${schedule}\n\n${ru ? 'Я буду напоминать о каждом приёме пищи!' : 'I\'ll send you a reminder with meal suggestions before each one!'}`, { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('act_')) {
    const levels = { act_low: 'Sedentary', act_moderate: 'Moderate', act_high: 'High', act_athlete: 'Athlete' };
    const levelsRu = { act_low: 'Низкий', act_moderate: 'Средний', act_high: 'Высокий', act_athlete: 'Атлет' };
    user.activity_level = levels[data];
    DB.updateUser(user);
    session.step = 'diet';
    session.dietSelections = [];
    await ctx.answerCbQuery();
    const label = user.lang === 'ru' ? levelsRu[data] : levels[data];
    await ctx.editMessageText(`✅ ${label}`);
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
      await ctx.editMessageText(`✅ ${user.lang === 'ru' ? 'Нет ограничений' : 'No restrictions'}`);
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
      await ctx.editMessageText(`✅ ${user.diet_restrictions || (user.lang === 'ru' ? 'Нет ограничений' : 'No restrictions')}`);
      await ctx.reply(t(user, 'goal_q'), { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'goal_energy'), callback_data: 'goal_energy' }],
        [{ text: t(user, 'goal_longevity'), callback_data: 'goal_longevity' }],
        [{ text: t(user, 'goal_weight'), callback_data: 'goal_weight' }],
        [{ text: t(user, 'goal_general'), callback_data: 'goal_general' }]
      ]}});
      return;
    }
    // Toggle selection
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

  if (data === 'meal_reroll') {
    if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chat_count++; DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'MEAL_REROLL', '');
    await ctx.answerCbQuery();
    await ctx.reply(t(user, 'meal_plan_gen'));
    const prompt = user.is_pro ? MEAL_PLAN_PROMPT_PRO : MEAL_PLAN_PROMPT_1DAY;
    const maxTok = user.is_pro ? 8000 : 3000;
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: maxTok,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: `Generate a DIFFERENT meal plan from the previous one. Use different dishes and cuisines.${profileContext(user)}` }]
      });
      await sendLong(ctx, r.choices[0].message.content);
      const ru = user.lang === 'ru';
      await ctx.reply(ru ? '👇 Хотите другой вариант?' : '👇 Want a different plan?', { reply_markup: { inline_keyboard: [
        [{ text: ru ? '🔄 Другой вариант' : '🔄 Another plan', callback_data: 'meal_reroll' }]
      ]}});
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }

  if (data.startsWith('goal_')) {
    const goals = { goal_energy: 'Energy & Performance', goal_longevity: 'Longevity & Anti-aging', goal_weight: 'Weight Optimization', goal_general: 'General Health' };
    const goalsRu = { goal_energy: 'Энергия и производительность', goal_longevity: 'Долголетие', goal_weight: 'Оптимизация веса', goal_general: 'Общее здоровье' };
    user.goal = goals[data];
    DB.updateUser(user);
    session.step = 'ready';
    await ctx.answerCbQuery();
    const label = user.lang === 'ru' ? goalsRu[data] : goals[data];
    await ctx.editMessageText(`✅ ${label}`);
    await ctx.reply(t(user, 'profile_done'), getMenu(user));
  }
});

// ─── Photo ───
bot.on('photo', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);

  if (!canUse(user, 'analysis')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }

  const mode = session.awaitingImage || 'analysis';
  session.awaitingImage = null;
  const prompts = { document: DOC_PROMPT, food: FOOD_PROMPT, analysis: ANALYSIS_PROMPT };
  const prompt = prompts[mode] || ANALYSIS_PROMPT;

  const labelKeys = { document: 'interpreting', food: 'scanning_food', analysis: 'analyzing' };
  await ctx.reply(t(user, labelKeys[mode] || 'analyzing'));

  try {
    const photos = ctx.message.photo;
    const base64 = await getImageBase64(ctx, photos[photos.length - 1].file_id);
    const caption = ctx.message.caption || '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 4000,
      messages: [
        { role: 'system', content: prompt },
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
    if (!user.is_pro) {
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
    if (!canUse(user, 'analysis')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    await ctx.reply('🔬 Analyzing...');
    try {
      const base64 = await getImageBase64(ctx, doc.file_id);
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 4000,
        messages: [
          { role: 'system', content: ANALYSIS_PROMPT },
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

// ─── Text ───
bot.on('text', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);
  const rawText = ctx.message.text.trim();
  const text = RU_TO_CMD[rawText] || rawText;

  // Onboarding: age
  if (session.step === 'age') {
    const age = parseInt(text);
    if (age > 0 && age < 120) {
      user.age = age;
      DB.updateUser(user);
      session.step = 'height';
      await ctx.reply(`✅ ${age}\n\n${t(user, 'height_q')}`);
    } else {
      await ctx.reply(user.lang === 'ru' ? 'Введите корректный возраст (1-119).' : 'Enter valid age (1-119).');
    }
    return;
  }

  // Onboarding: height
  if (session.step === 'height') {
    const h = parseInt(text);
    if (h > 50 && h < 300) {
      user.height = h;
      DB.updateUser(user);
      session.step = 'weight';
      await ctx.reply(`✅ ${h} ${user.lang === 'ru' ? 'см' : 'cm'}\n\n${t(user, 'weight_q')}`);
    } else {
      await ctx.reply(user.lang === 'ru' ? 'Введите рост в см (50-300).' : 'Enter height in cm (50-300).');
    }
    return;
  }

  // Onboarding: weight
  if (session.step === 'weight') {
    const w = parseFloat(text);
    if (w > 20 && w < 500) {
      user.weight = w;
      DB.updateUser(user);
      session.step = 'activity';
      await ctx.reply(`✅ ${w} ${user.lang === 'ru' ? 'кг' : 'kg'}\n\n${t(user, 'activity_q')}`, { reply_markup: { inline_keyboard: [
        [{ text: t(user, 'activity_low'), callback_data: 'act_low' }],
        [{ text: t(user, 'activity_moderate'), callback_data: 'act_moderate' }],
        [{ text: t(user, 'activity_high'), callback_data: 'act_high' }],
        [{ text: t(user, 'activity_athlete'), callback_data: 'act_athlete' }]
      ]}});
    } else {
      await ctx.reply(user.lang === 'ru' ? 'Введите вес в кг (20-500).' : 'Enter weight in kg (20-500).');
    }
    return;
  }

  // Symptom input
  if (session.awaitingSymptoms) {
    session.awaitingSymptoms = false;
    if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chat_count++;
    DB.updateUser(user);
    DB.addSymptom(ctx.from.id, text);
    DB.logEvent(ctx.from.id, 'SYMPTOM', text.slice(0, 100));
    await ctx.reply('🔍 Analyzing symptoms...');
    try {
      const symptoms = DB.getSymptoms(ctx.from.id).map(s => `${s.created_at}: ${s.text}`).join('\n');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 2000,
        messages: [
          { role: 'system', content: SYMPTOM_PROMPT },
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

  // ─── Menu ───
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
    if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chat_count++; DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'MEAL_PLAN', '');
    await ctx.reply(t(user, 'meal_plan_gen'));
    const prompt = user.is_pro ? MEAL_PLAN_PROMPT_PRO : MEAL_PLAN_PROMPT_1DAY;
    const maxTok = user.is_pro ? 8000 : 3000;
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: maxTok,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: `Meal plan.${profileContext(user)}` }]
      });
      await sendLong(ctx, r.choices[0].message.content);
      const ru = user.lang === 'ru';
      await ctx.reply(ru ? '👇 Хотите другой вариант?' : '👇 Want a different plan?', { reply_markup: { inline_keyboard: [
        [{ text: ru ? '🔄 Другой вариант' : '🔄 Another plan', callback_data: 'meal_reroll' }]
      ]}});
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }
  if (text === '💊 Supplement Protocol') {
    if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chat_count++; DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'SUPPLEMENT', '');
    await ctx.reply(t(user, 'supplement_gen'));
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 3000,
        messages: [{ role: 'system', content: SUPPLEMENT_PROMPT }, { role: 'user', content: `Supplements.${profileContext(user)}` }]
      });
      await sendLong(ctx, r.choices[0].message.content);
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }
  if (text === '⏰ Meal Reminders') {
    const ru = user.lang === 'ru';
    // Check if already has reminders
    if (reminders[ctx.from.id] && reminders[ctx.from.id].length > 0) {
      const r = reminders[ctx.from.id];
      const mealRu = { Breakfast: 'Завтрак', Lunch: 'Обед', Dinner: 'Ужин', Snack: 'Перекус' };
      const schedule = r.map(m => `⏰ ${m.localTime} — ${ru ? (mealRu[m.meal] || m.meal) : m.meal}`).join('\n');
      await ctx.reply(`🍽 *${ru ? 'Ваши напоминания' : 'Your reminders'}:*\n\n${schedule}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: ru ? '🔄 Изменить расписание' : '🔄 Change schedule', callback_data: 'remind_setup' }],
        [{ text: ru ? '❌ Отключить напоминания' : '❌ Turn off reminders', callback_data: 'remind_off' }]
      ]}});
    } else {
      await ctx.reply(`⏰ *${ru ? 'Напоминания о еде' : 'Meal Reminders'}*\n\n${ru ? 'Я напомню когда и что поесть.\n\nВыберите часовой пояс:' : 'I\'ll remind you when to eat and what to eat.\n\nChoose your timezone:'}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
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
  if (text === '👤 My Profile') {
    const ru = user.lang === 'ru';
    await ctx.replyWithMarkdown([
      `👤 *${ru ? 'Ваш профиль' : 'Your Profile'}*`,
      `${ru ? 'Пол' : 'Sex'}: ${user.gender || (ru ? 'Не указан' : 'Not set')}`,
      user.pregnancy_status && user.pregnancy_status !== 'not pregnant' ? `${ru ? 'Статус' : 'Status'}: ${user.pregnancy_status}` : null,
      `${ru ? 'Возраст' : 'Age'}: ${user.age || (ru ? 'Не указан' : 'Not set')}`,
      `${ru ? 'Рост' : 'Height'}: ${user.height ? user.height + (ru ? ' см' : ' cm') : (ru ? 'Не указан' : 'Not set')}`,
      `${ru ? 'Вес' : 'Weight'}: ${user.weight ? user.weight + (ru ? ' кг' : ' kg') : (ru ? 'Не указан' : 'Not set')}`,
      `${ru ? 'Активность' : 'Activity'}: ${user.activity_level || (ru ? 'Не указана' : 'Not set')}`,
      `${ru ? 'Ограничения' : 'Diet'}: ${user.diet_restrictions || (ru ? 'Нет' : 'None')}`,
      `${ru ? 'Цель' : 'Goal'}: ${user.goal || (ru ? 'Не указана' : 'Not set')}`,
      `\n📊 *${ru ? 'Использование' : 'Usage'}*`,
      `${ru ? 'Анализы' : 'Analyses'}: ${user.analysis_count}/${user.is_pro ? '∞' : FREE_ANALYSIS_LIMIT}`,
      `${ru ? 'Чаты' : 'Chats'}: ${user.chat_count}/${user.is_pro ? '∞' : FREE_CHAT_LIMIT}`,
      `\n${user.is_pro ? `⭐ *${ru ? 'Pro участник' : 'Pro Member'}*` : `[${ru ? 'Перейти на Pro' : 'Upgrade to Pro'}](${CHECKOUT_URL})`}`
    ].filter(Boolean).join('\n'));
    return;
  }
  if (text === '⭐ Upgrade to Pro') {
    DB.logEvent(ctx.from.id, 'UPGRADE_CLICK', '');
    const personalUrl = `${CHECKOUT_URL}?checkout[custom][telegram_id]=${ctx.from.id}`;
    await ctx.replyWithMarkdown(`⭐ *Metabolic Center Pro — $19/mo*\n\n✦ Unlimited everything\n✦ Priority AI processing\n\n_Founding price locked forever._\n\n👉 [Subscribe Now](${personalUrl})`);
    return;
  }

  // ─── General chat ───
  if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
  user.chat_count++; DB.updateUser(user);
  DB.logEvent(ctx.from.id, 'CHAT', text.slice(0, 100));

  try {
    session.history.push({ role: 'user', content: text });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    const r = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 1500,
      messages: [{ role: 'system', content: CHAT_PROMPT + (user.is_pro ? '' : '\nUser is on FREE plan. Limit meal/diet plans to 1 day only. Always end meal plans with: "🔒 *Full 7-day plan + shopping list → Pro*"') + profileContext(user) }, ...session.history]
    });
    const reply = r.choices[0].message.content;
    session.history.push({ role: 'assistant', content: reply });
    await sendLong(ctx, reply);
  } catch (e) {
    console.error('Chat error:', e?.message);
    await ctx.reply('❌ Error. Try again.');
  }
});

// ─── Webhook server for LemonSqueezy ───
const WEBHOOK_SECRET = process.env.LEMON_WEBHOOK_SECRET || '';
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook/lemon') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        // Verify signature if secret is set
        if (WEBHOOK_SECRET) {
          const sig = req.headers['x-signature'] || '';
          const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
          if (sig !== hmac) {
            console.error('Invalid webhook signature');
            res.writeHead(401);
            res.end('Invalid signature');
            return;
          }
        }

        const data = JSON.parse(body);
        const eventName = data.meta?.event_name;
        const email = data.data?.attributes?.user_email;
        const customData = data.meta?.custom_data || {};
        const telegramId = customData.telegram_id;

        console.log(`Webhook: ${eventName} | email: ${email} | tg: ${telegramId}`);
        DB.logEvent(telegramId || 0, 'WEBHOOK', `${eventName} | ${email}`);

        // Activate Pro on subscription created
        if (eventName === 'subscription_created' || eventName === 'order_created') {
          if (telegramId) {
            const user = DB.getUser(parseInt(telegramId));
            if (user) {
              user.is_pro = 1;
              DB.updateUser(user);
              DB.logEvent(telegramId, 'PRO_ACTIVATED', email);
              // Notify user
              bot.telegram.sendMessage(telegramId, '🎉 *Welcome to Metabolic Center Pro!*\n\nYou now have unlimited access to all features. Enjoy!', { parse_mode: 'Markdown' }).catch(console.error);
            }
          }
        }

        // Deactivate on subscription expired/cancelled
        if (eventName === 'subscription_expired' || eventName === 'subscription_cancelled') {
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

// ─── Launch ───
bot.catch((err) => console.error('Bot error:', err));
bot.launch().then(() => {
  console.log('🧬 Metabolic Center Bot is running!');
  startReminderLoop();
  console.log('⏰ Reminder loop started');
});
process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
