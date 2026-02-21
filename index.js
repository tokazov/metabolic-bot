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
          const ru = rUser?.lang === 'ru';
          const mealRu = { Breakfast: 'Завтрак', Lunch: 'Обед', Dinner: 'Ужин', Snack: 'Перекус' };
          const mealName = ru ? (mealRu[r.meal] || r.meal) : r.meal;
          const footer = ru ? '_Приятного аппетита! Отправьте фото еды — я её проанализирую._' : '_Bon appétit! Reply with a food photo and I\'ll scan it._';
          bot.telegram.sendMessage(userId,
            `⏰ *${ru ? 'Напоминание' : 'Meal Reminder'}: ${mealName}*\n\n${r.text}\n\n${footer}`,
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
  const ru = user?.lang === 'ru';
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of entries) {
    totals.calories += e.calories || 0;
    totals.protein += e.protein || 0;
    totals.carbs += e.carbs || 0;
    totals.fat += e.fat || 0;
  }
  const msg = ru
    ? `📊 *Итоги дня*\n\n🍽 Приёмов пищи: ${entries.length}\n🔥 Калории: ${totals.calories} kcal\n🥩 Белки: ${totals.protein.toFixed(1)}g\n🍞 Углеводы: ${totals.carbs.toFixed(1)}g\n🧈 Жиры: ${totals.fat.toFixed(1)}g\n\n_Хороший день! Продолжайте вести дневник 💪_`
    : `📊 *Daily Summary*\n\n🍽 Meals logged: ${entries.length}\n🔥 Calories: ${totals.calories} kcal\n🥩 Protein: ${totals.protein.toFixed(1)}g\n🍞 Carbs: ${totals.carbs.toFixed(1)}g\n🧈 Fat: ${totals.fat.toFixed(1)}g\n\n_Great job tracking today! Keep it up 💪_`;
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
            const ru = user.lang === 'ru';
            const themes = ['Hydration', 'Sugar-free', 'Green day', 'Anti-inflammatory', 'Gut health', 'Antioxidants', 'Integration'];
            const themesRu = ['Гидратация', 'Без сахара', 'Зелёный день', 'Противовоспалительный', 'Здоровье кишечника', 'Антиоксиданты', 'Интеграция'];
            const theme = ru ? themesRu[currentDay - 1] : themes[currentDay - 1];
            bot.telegram.sendMessage(d.user_id,
              `🧹 *${ru ? 'Детокс — День' : 'Detox — Day'} ${currentDay}: ${theme}*\n\n${ru ? 'Нажмите "📋 Задание дня" чтобы узнать план!' : 'Tap "📋 Today\'s task" to see your plan!'}`,
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

// ─── Translations ───
const i18n = {
  en: {
    welcome: `🧬 *Welcome to Metabolic Center*\n\nYour AI Metabolic Intelligence assistant.\n\n🔬 *Analyze Blood Tests* — full metabolic report from a photo\n📸 *Scan Food* — photo your meal, get calories & metabolic score\n🥗 *Meal Plan* — personalized nutrition\n💊 *Supplement Protocol* — evidence-based stack\n📋 *Track Symptoms* — detect patterns\n📄 *Interpret Documents* — explain any medical doc\n📔 *Food Diary* — track meals & macros\n🧹 *Detox Program* — 7-day challenge\n💬 *Health Chat* — ask anything\n\n📸 *2 free analyses + 10 free chats to start!*`,
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
    // Trial
    try_pro_btn: '🎁 Try Pro FREE for 24h',
    trial_activated: '🎉 *Pro trial activated!*\n\nYou have full access for 24 hours. Enjoy all features!\n\n⏰ Trial ends: ',
    trial_expired: '⏰ *Your Pro trial has ended.*\n\nUpgrade to keep full access:\n👉 [Upgrade to Pro — $19/mo](CHECKOUT_URL)',
    trial_already_used: '⚠️ You\'ve already used your free trial. Upgrade to Pro for full access!',
    // Food Diary
    food_diary_title: '📔 *Food Diary*',
    food_diary_log: '📸 Log meal',
    food_diary_summary: '📊 Today\'s summary',
    food_diary_history: '📅 History',
    food_diary_send_photo: '📸 Send a photo of your meal to log it.',
    food_diary_logged: '✅ *Meal logged!*',
    food_diary_no_entries: 'No meals logged today. Start by sending a food photo!',
    food_diary_analyzing: '📸 Analyzing your meal for the diary...',
    // Referral
    referral_title: '🎁 *Invite a Friend*',
    referral_text: 'Share your link — when a friend joins, you get *+7 days of Pro* for free!\n\nYour link:\n',
    referral_friend_joined: '🎉 Your friend joined! *+7 days Pro* added!',
    referral_stats: 'Friends invited',
    referral_btn: '🎁 Invite friend',
    // Detox
    detox_title: '🧹 *7-Day Detox Program*',
    detox_desc: 'A guided 7-day metabolic reset tailored to your profile.\n\n🗓 Day 1: Hydration\n🗓 Day 2: Sugar-free\n🗓 Day 3: Green day\n🗓 Day 4: Anti-inflammatory\n🗓 Day 5: Gut health\n🗓 Day 6: Antioxidants\n🗓 Day 7: Integration',
    detox_start: '🚀 Start 7-day Detox',
    detox_today_task: '📋 Today\'s task',
    detox_complete_day: '✅ Complete day',
    detox_started: '🧹 *Detox started!* Day 1: Hydration\n\nTap "📋 Today\'s task" to see your plan.',
    detox_day_completed: '✅ *Day DAYNUM completed!* Great job!',
    detox_all_done: '🎉 *Congratulations!* You completed the 7-day detox!',
    detox_not_active: 'You don\'t have an active detox. Start one first!',
    detox_pro_required: '🔒 *Days 3-7 require Pro.*\n\nUpgrade to continue your detox journey!\n👉 [Upgrade to Pro](CHECKOUT_URL)',
    detox_generating: '🧹 Generating your detox plan...',
    detox_status: 'Day CURRENT/7 — COMPLETED completed',
  },
  ru: {
    welcome: `🧬 *Добро пожаловать в Metabolic Center*\n\nВаш AI-ассистент метаболического здоровья.\n\n🔬 *Анализ крови* — полный отчёт по фото\n📸 *Сканер еды* — фото блюда → калории и оценка\n🥗 *План питания* — персональное меню\n💊 *Протокол добавок* — подбор добавок\n📋 *Трекер симптомов* — отслеживание паттернов\n📄 *Расшифровка документов* — объяснение мед. документов\n📔 *Дневник питания* — учёт калорий и макросов\n🧹 *Детокс программа* — 7-дневный челлендж\n💬 *Чат о здоровье* — любые вопросы\n\n📸 *2 бесплатных анализа + 10 чатов!*`,
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
    // Trial
    try_pro_btn: '🎁 Попробуйте Pro БЕСПЛАТНО на 24ч',
    trial_activated: '🎉 *Пробный Pro активирован!*\n\nВам доступны все функции на 24 часа!\n\n⏰ Пробный период до: ',
    trial_expired: '⏰ *Ваш пробный период Pro закончился.*\n\nОбновитесь для полного доступа:\n👉 [Перейти на Pro — $19/мес](CHECKOUT_URL)',
    trial_already_used: '⚠️ Вы уже использовали пробный период. Оформите Pro для полного доступа!',
    // Food Diary
    food_diary_title: '📔 *Дневник питания*',
    food_diary_log: '📸 Записать приём пищи',
    food_diary_summary: '📊 Итоги за сегодня',
    food_diary_history: '📅 История',
    food_diary_send_photo: '📸 Отправьте фото блюда для записи.',
    food_diary_logged: '✅ *Приём пищи записан!*',
    food_diary_no_entries: 'Сегодня нет записей. Начните — отправьте фото еды!',
    food_diary_analyzing: '📸 Анализирую блюдо для дневника...',
    // Referral
    referral_title: '🎁 *Пригласите друга*',
    referral_text: 'Поделитесь ссылкой — когда друг присоединится, вы получите *+7 дней Pro* бесплатно!\n\nВаша ссылка:\n',
    referral_friend_joined: '🎉 Ваш друг присоединился! *+7 дней Pro* добавлено!',
    referral_stats: 'Приглашено друзей',
    referral_btn: '🎁 Пригласить друга',
    // Detox
    detox_title: '🧹 *7-дневная Детокс Программа*',
    detox_desc: 'Персональный 7-дневный метаболический сброс.\n\n🗓 День 1: Гидратация\n🗓 День 2: Без сахара\n🗓 День 3: Зелёный день\n🗓 День 4: Противовоспалительный\n🗓 День 5: Здоровье кишечника\n🗓 День 6: Антиоксиданты\n🗓 День 7: Интеграция',
    detox_start: '🚀 Начать 7-дневный Детокс',
    detox_today_task: '📋 Задание дня',
    detox_complete_day: '✅ Завершить день',
    detox_started: '🧹 *Детокс начат!* День 1: Гидратация\n\nНажмите "📋 Задание дня" чтобы увидеть план.',
    detox_day_completed: '✅ *День DAYNUM завершён!* Отличная работа!',
    detox_all_done: '🎉 *Поздравляем!* Вы завершили 7-дневный детокс!',
    detox_not_active: 'У вас нет активного детокса. Начните сначала!',
    detox_pro_required: '🔒 *Дни 3-7 доступны только в Pro.*\n\nОбновитесь чтобы продолжить детокс!\n👉 [Перейти на Pro](CHECKOUT_URL)',
    detox_generating: '🧹 Создаю ваш план детокса...',
    detox_status: 'День CURRENT/7 — COMPLETED завершено',
  }
};

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

// ─── Menu (6 rows) ───
const MENU_EN = [
  ['🔬 Analyze Blood Test', '📸 Scan Food'],
  ['🥗 Meal Plan', '💊 Supplement Protocol'],
  ['📋 Track Symptoms', '📄 Interpret Document'],
  ['📔 Food Diary', '🧹 Detox Program'],
  ['⏰ Meal Reminders', '💬 Health Chat'],
  ['👤 My Profile', '⭐ Upgrade to Pro']
];
const MENU_RU = [
  ['🔬 Анализ крови', '📸 Сканер еды'],
  ['🥗 План питания', '💊 Протокол добавок'],
  ['📋 Симптомы', '📄 Расшифровка'],
  ['📔 Дневник питания', '🧹 Детокс'],
  ['⏰ Напоминания', '💬 Чат со специалистом'],
  ['👤 Мой профиль', '⭐ Pro подписка']
];
function getMenu(user) {
  const rows = (user?.lang === 'ru') ? MENU_RU : MENU_EN;
  return Markup.keyboard(rows).resize();
}
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
  '⭐ Pro подписка': '⭐ Upgrade to Pro',
  '📔 Дневник питания': '📔 Food Diary',
  '🧹 Детокс': '🧹 Detox Program',
};

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

bot.command('referral', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const code = ensureReferralCode(user);
  const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
  const count = DB.countReferrals(user.id);
  const ru = user.lang === 'ru';
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

  // Check trial expiry on every callback
  if (checkTrialExpiry(user)) {
    await bot.telegram.sendMessage(ctx.from.id, t(user, 'trial_expired'), { parse_mode: 'Markdown' }).catch(() => {});
  }

  if (data.startsWith('lang_')) {
    user.lang = data.replace('lang_', '');
    DB.updateUser(user);
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
    if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
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
    const ru = user.lang === 'ru';

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
        model: 'gpt-4o', max_tokens: maxTok,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: `${plan.en} meal plan. Style: ${plan.hint}.${extra}${profileContext(user)}` }]
      });
      await sendLong(ctx, r.choices[0].message.content);
      await ctx.reply(ru ? '👇 Что дальше?' : '👇 What next?', { reply_markup: { inline_keyboard: [
        [{ text: ru ? '🔄 Другой вариант' : '🔄 Another variant', callback_data: 'meal_reroll' }],
        [{ text: ru ? '🔙 Выбрать другой тип' : '🔙 Choose different type', callback_data: 'mp_menu' }]
      ]}});
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }

  if (data === 'mp_menu') {
    const ru = user.lang === 'ru';
    await ctx.answerCbQuery();
    await ctx.reply(ru ? '🥗 *Выберите тип плана питания:*' : '🥗 *Choose your meal plan type:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: ru ? '⚖️ Сбалансированное питание' : '⚖️ Balanced Diet', callback_data: 'mp_balanced' }],
        [{ text: ru ? '🔥 Интервальное голодание 16:8' : '🔥 Intermittent Fasting 16:8', callback_data: 'mp_if16' }],
        [{ text: ru ? '🥑 Кето / Низкоуглеводная' : '🥑 Keto / Low-Carb', callback_data: 'mp_keto' }],
        [{ text: ru ? '🌱 Средиземноморская диета' : '🌱 Mediterranean Diet', callback_data: 'mp_mediterranean' }],
        [{ text: ru ? '💪 Набор мышечной массы' : '💪 Muscle Gain / High-Protein', callback_data: 'mp_muscle' }],
        [{ text: ru ? '🏃 Сушка / Дефицит калорий' : '🏃 Fat Loss / Calorie Deficit', callback_data: 'mp_cut' }],
        [{ text: ru ? '🌿 Вегетарианское / Веганское' : '🌿 Vegetarian / Vegan', callback_data: 'mp_vegan' }],
        [{ text: ru ? '🧬 Анти-эйдж / Долголетие' : '🧬 Anti-aging / Longevity', callback_data: 'mp_longevity' }],
      ]}
    });
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

    // Ensure referral code
    ensureReferralCode(user);

    // Profile done — offer trial if never used
    await ctx.reply(t(user, 'profile_done'), getMenu(user));
    if (!user.trial_used && !user.is_pro) {
      const ru = user.lang === 'ru';
      await ctx.reply(ru ? '🎁 Хотите попробовать все функции бесплатно?' : '🎁 Want to try all features for free?', {
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
    const ru = user.lang === 'ru';
    const msg = `📊 *${ru ? 'Итоги за сегодня' : 'Today\'s Summary'}*\n\n${items.join('\n')}\n\n━━━━━━━━━━━━━━━━━━━━━\n🔥 ${ru ? 'Калории' : 'Calories'}: ${totals.calories} kcal\n🥩 ${ru ? 'Белки' : 'Protein'}: ${totals.protein.toFixed(1)}g\n🍞 ${ru ? 'Углеводы' : 'Carbs'}: ${totals.carbs.toFixed(1)}g\n🧈 ${ru ? 'Жиры' : 'Fat'}: ${totals.fat.toFixed(1)}g`;
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
    const ru = user.lang === 'ru';
    // Group by date
    const byDate = {};
    for (const e of entries) {
      const date = (e.created_at || '').slice(0, 10);
      if (!byDate[date]) byDate[date] = { entries: [], calories: 0 };
      byDate[date].entries.push(e);
      byDate[date].calories += e.calories || 0;
    }
    let msg = `📅 *${ru ? 'История питания' : 'Food History'}*\n\n`;
    for (const [date, data] of Object.entries(byDate)) {
      msg += `*${date}* — ${data.calories} kcal (${data.entries.length} ${ru ? 'приёмов' : 'meals'})\n`;
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
    const ru = user.lang === 'ru';
    await ctx.reply(ru ? '👇 Что дальше?' : '👇 What\'s next?', { reply_markup: { inline_keyboard: [
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
        model: 'gpt-4o', max_tokens: 2000,
        messages: [
          { role: 'system', content: DETOX_PROMPT },
          { role: 'user', content: `Day ${currentDay} of 7-day detox. Theme: ${theme}.${profileContext(user)}` }
        ]
      });
      await sendLong(ctx, r.choices[0].message.content);
      const ru = user.lang === 'ru';
      await ctx.reply(ru ? '👇 Когда выполните:' : '👇 When you\'re done:', { reply_markup: { inline_keyboard: [
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
      const ru = user.lang === 'ru';
      const nextDay = currentDay + 1;
      if (nextDay >= 3 && !isPro(user)) {
        await ctx.replyWithMarkdown(t(user, 'detox_pro_required'));
      } else {
        await ctx.reply(ru ? `🗓 Завтра День ${nextDay}!` : `🗓 Tomorrow is Day ${nextDay}!`, { reply_markup: { inline_keyboard: [
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
        model: 'gpt-4o', max_tokens: 300,
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

      const ru = user.lang === 'ru';
      const msg = `${t(user, 'food_diary_logged')}\n\n🍽 *${parsed.description}*\n🔥 ${parsed.calories} kcal\n🥩 ${ru ? 'Б' : 'P'}: ${parsed.protein}g | 🍞 ${ru ? 'У' : 'C'}: ${parsed.carbs}g | 🧈 ${ru ? 'Ж' : 'F'}: ${parsed.fat}g`;
      await ctx.replyWithMarkdown(msg);

      // Also do full food analysis
      const fullResponse = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 2000,
        messages: [
          { role: 'system', content: FOOD_PROMPT },
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

  if (!canUse(user, 'analysis')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }

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
      await ctx.reply(user.lang === 'ru' ? 'Введите корректный возраст (1-119).' : 'Enter valid age (1-119).');
    }
    return;
  }

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
    const ru = user.lang === 'ru';
    await ctx.reply(ru ? '🥗 *Выберите тип плана питания:*' : '🥗 *Choose your meal plan type:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: ru ? '⚖️ Сбалансированное питание' : '⚖️ Balanced Diet', callback_data: 'mp_balanced' }],
        [{ text: ru ? '🔥 Интервальное голодание 16:8' : '🔥 Intermittent Fasting 16:8', callback_data: 'mp_if16' }],
        [{ text: ru ? '🥑 Кето / Низкоуглеводная' : '🥑 Keto / Low-Carb', callback_data: 'mp_keto' }],
        [{ text: ru ? '🌱 Средиземноморская диета' : '🌱 Mediterranean Diet', callback_data: 'mp_mediterranean' }],
        [{ text: ru ? '💪 Набор мышечной массы' : '💪 Muscle Gain / High-Protein', callback_data: 'mp_muscle' }],
        [{ text: ru ? '🏃 Сушка / Дефицит калорий' : '🏃 Fat Loss / Calorie Deficit', callback_data: 'mp_cut' }],
        [{ text: ru ? '🌿 Вегетарианское / Веганское' : '🌿 Vegetarian / Vegan', callback_data: 'mp_vegan' }],
        [{ text: ru ? '🧬 Анти-эйдж / Долголетие' : '🧬 Anti-aging / Longevity', callback_data: 'mp_longevity' }],
      ]}
    });
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
    // Check if user has completed onboarding and chosen a meal plan
    if (!user.goal || !user.has_meal_plan) {
      const msg = !user.goal
        ? (ru ? '⏰ Напоминания станут доступны после завершения настройки профиля и выбора плана питания.\n\nПожалуйста, сначала завершите настройку профиля 👆'
              : '⏰ Reminders will be available after you complete your profile setup and choose a meal plan.\n\nPlease complete your profile first 👆')
        : (ru ? '⏰ Напоминания станут доступны после выбора плана питания.\n\nНажмите 🥗 *План питания* в меню, чтобы выбрать свой план.'
              : '⏰ Reminders will be available after you choose a meal plan.\n\nPress 🥗 *Meal Plan* in the menu to choose your plan.');
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      return;
    }
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

  // ─── Food Diary menu ───
  if (text === '📔 Food Diary') {
    const ru = user.lang === 'ru';
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
    const ru = user.lang === 'ru';
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
          [{ text: ru ? '🔄 Начать заново' : '🔄 Restart', callback_data: 'detox_start' }]
        ]}
      });
    } else {
      await ctx.reply(`${t(user, 'detox_title')}\n\n${t(user, 'detox_desc')}\n\n${!isPro(user) ? (ru ? '_Дни 1-2 бесплатно, полная программа — Pro_' : '_Days 1-2 free, full program — Pro_') : ''}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: t(user, 'detox_start'), callback_data: 'detox_start' }]
        ]}
      });
    }
    return;
  }

  if (text === '👤 My Profile') {
    const ru = user.lang === 'ru';
    const refCount = DB.countReferrals(user.id);
    const code = ensureReferralCode(user);
    const trialInfo = user.trial_expires && user.trial_expires > Date.now()
      ? `\n⏰ ${ru ? 'Пробный до' : 'Trial until'}: ${new Date(user.trial_expires).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : '';
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
      `${ru ? 'Анализы' : 'Analyses'}: ${user.analysis_count}/${isPro(user) ? '∞' : FREE_ANALYSIS_LIMIT}`,
      `${ru ? 'Чаты' : 'Chats'}: ${user.chat_count}/${isPro(user) ? '∞' : FREE_CHAT_LIMIT}`,
      `\n👥 ${t(user, 'referral_stats')}: ${refCount}`,
      trialInfo,
      `\n${isPro(user) ? `⭐ *${ru ? 'Pro участник' : 'Pro Member'}*` : `[${ru ? 'Перейти на Pro' : 'Upgrade to Pro'}](${CHECKOUT_URL})`}`
    ].filter(Boolean).join('\n'));

    // Show referral button under profile
    await ctx.reply(ru ? '👇 Действия:' : '👇 Actions:', { reply_markup: { inline_keyboard: [
      [{ text: t(user, 'referral_btn'), callback_data: 'referral_show' }]
    ]}});
    return;
  }
  if (text === '⭐ Upgrade to Pro') {
    DB.logEvent(ctx.from.id, 'UPGRADE_CLICK', '');
    const personalUrl = `${CHECKOUT_BASE}/product/${PADDLE_PRICE_ID}?custom_data[telegram_id]=${ctx.from.id}`;
    const ru = user.lang === 'ru';
    await ctx.replyWithMarkdown(ru 
      ? `⭐ *Metabolic Center Pro — $19/мес*\n\n✦ Безлимитный доступ\n✦ 7-дневные планы питания + список покупок\n✦ Полная детокс-программа\n\n_Цена основателя зафиксирована навсегда._\n\n👉 [Подписаться](${personalUrl})`
      : `⭐ *Metabolic Center Pro — $19/mo*\n\n✦ Unlimited everything\n✦ 7-day meal plans + shopping lists\n✦ Full detox program\n\n_Founding price locked forever._\n\n👉 [Subscribe Now](${personalUrl})`);
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
      messages: [{ role: 'system', content: CHAT_PROMPT + (isPro(user) ? '' : '\nUser is on FREE plan. Limit meal/diet plans to 1 day only. Always end meal plans with: "🔒 *Full 7-day plan + shopping list → Pro*"') + profileContext(user) }, ...session.history]
    });
    const reply = r.choices[0].message.content;
    session.history.push({ role: 'assistant', content: reply });
    await sendLong(ctx, reply);
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
