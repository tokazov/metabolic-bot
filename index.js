const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const https = require('https');
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

// In-memory session state (not persisted — onboarding step, awaiting flags, chat history)
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
Respond in user's language. Default English.
End with disclaimer: "AI-generated analysis. Not medical advice. Consult your healthcare provider."`;

const CHAT_PROMPT = `You are the Metabolic Center AI — a premium health intelligence assistant.
You help with: metabolic health, nutrition, supplements, sleep, exercise, biomarkers, longevity.
Be concise, evidence-based, actionable. Respond in user's language.
End health advice with: "This is AI-generated guidance, not medical advice."`;

const MEAL_PLAN_PROMPT = `You are a precision nutrition AI for Metabolic Center.
Generate a detailed personalized meal plan. Include: daily calories, macros, breakfast/lunch/dinner/snacks with portions, meal timing, foods to avoid, hydration, weekly shopping list.
Tailor to goal and profile. Respond in user's language.`;

const SUPPLEMENT_PROMPT = `You are a supplement protocol AI for Metabolic Center.
Create personalized evidence-based supplement protocol. Include: exact dosages, timing, morning vs evening stack, with food vs empty stomach, best forms, interactions, expected timeline.
End with: "Consult your healthcare provider before starting supplements."`;

const SYMPTOM_PROMPT = `You are a symptom analysis AI for Metabolic Center.
Analyze symptoms: identify metabolic connections, suggest biomarkers to test, recommend lifestyle adjustments, flag urgent items, track patterns.
End with: "This is not a diagnosis. See a doctor for persistent symptoms."`;

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
  if (!user || (!user.gender && !user.age)) return '';
  let s = `\nPatient: ${user.gender || '?'}, ${user.age || '?'} years`;
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
const MAIN_MENU = Markup.keyboard([
  ['🔬 Analyze Blood Test', '🥗 Meal Plan'],
  ['💊 Supplement Protocol', '📋 Track Symptoms'],
  ['📄 Interpret Document', '💬 Health Chat'],
  ['👤 My Profile', '⭐ Upgrade to Pro']
]).resize();

const WELCOME = `🧬 *Welcome to Metabolic Center*

Your AI Metabolic Intelligence assistant.

🔬 *Analyze Blood Tests* — full metabolic report from a photo
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
  session.step = 'gender';
  DB.logEvent(ctx.from.id, 'START', `@${ctx.from.username || ''} ${ctx.from.first_name || ''}`);
  await ctx.replyWithMarkdown(WELCOME, MAIN_MENU);
  setTimeout(() => {
    ctx.reply('Let me set up your profile.\n\n👤 Biological sex?', { reply_markup: { inline_keyboard: [
      [{ text: '♂️ Male', callback_data: 'gender_male' }, { text: '♀️ Female', callback_data: 'gender_female' }]
    ]}});
  }, 1000);
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

  if (data === 'gender_male' || data === 'gender_female') {
    user.gender = data === 'gender_male' ? 'male' : 'female';
    DB.updateUser(user);
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Sex: ${user.gender === 'male' ? 'Male' : 'Female'}`);
    if (user.gender === 'female') {
      session.step = 'pregnant';
      await ctx.reply('🤰 Are you pregnant or breastfeeding?', { reply_markup: { inline_keyboard: [
        [{ text: '🤰 Pregnant', callback_data: 'preg_yes' }],
        [{ text: '🤱 Breastfeeding', callback_data: 'preg_bf' }],
        [{ text: '❌ No', callback_data: 'preg_no' }]
      ]}});
    } else {
      session.step = 'age';
      await ctx.reply('📅 Your age? (type a number)');
    }
  }

  if (data.startsWith('preg_')) {
    user.pregnancy_status = { preg_yes: 'pregnant', preg_bf: 'breastfeeding', preg_no: 'not pregnant' }[data];
    DB.updateUser(user);
    session.step = 'age';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ ${user.pregnancy_status === 'not pregnant' ? 'Not pregnant' : user.pregnancy_status}`);
    await ctx.reply('📅 Your age? (type a number)');
  }

  if (data.startsWith('goal_')) {
    const goals = { goal_energy: 'Energy & Performance', goal_longevity: 'Longevity & Anti-aging', goal_weight: 'Weight Optimization', goal_general: 'General Health' };
    user.goal = goals[data];
    DB.updateUser(user);
    session.step = 'ready';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Goal: ${user.goal}`);
    await ctx.reply('✅ Profile complete! Use the menu below 👇', MAIN_MENU);
  }
});

// ─── Photo ───
bot.on('photo', async (ctx) => {
  const user = DB.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const session = getSession(ctx.from.id);

  if (!canUse(user, 'analysis')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }

  const mode = session.awaitingImage || 'analysis';
  session.awaitingImage = null;
  const prompt = mode === 'document' ? DOC_PROMPT : ANALYSIS_PROMPT;

  await ctx.reply(mode === 'document' ? '📄 Interpreting...' : '🔬 Analyzing... (30-60 sec)');

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
  const text = ctx.message.text.trim();

  // Onboarding: age
  if (session.step === 'age') {
    const age = parseInt(text);
    if (age > 0 && age < 120) {
      user.age = age;
      DB.updateUser(user);
      session.step = 'goal';
      await ctx.reply(`✅ Age: ${age}\n\n🎯 Primary goal?`, { reply_markup: { inline_keyboard: [
        [{ text: '⚡ Energy & Performance', callback_data: 'goal_energy' }],
        [{ text: '🧬 Longevity & Anti-aging', callback_data: 'goal_longevity' }],
        [{ text: '⚖️ Weight Optimization', callback_data: 'goal_weight' }],
        [{ text: '💚 General Health', callback_data: 'goal_general' }]
      ]}});
    } else {
      await ctx.reply('Enter valid age (1-119).');
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
    await ctx.reply('📸 Send a photo of your blood test results.');
    return;
  }
  if (text === '🥗 Meal Plan') {
    if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chat_count++; DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'MEAL_PLAN', '');
    await ctx.reply('🥗 Generating meal plan...');
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 3000,
        messages: [{ role: 'system', content: MEAL_PLAN_PROMPT }, { role: 'user', content: `Meal plan.${profileContext(user)}` }]
      });
      await sendLong(ctx, r.choices[0].message.content);
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }
  if (text === '💊 Supplement Protocol') {
    if (!canUse(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chat_count++; DB.updateUser(user);
    DB.logEvent(ctx.from.id, 'SUPPLEMENT', '');
    await ctx.reply('💊 Building protocol...');
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 3000,
        messages: [{ role: 'system', content: SUPPLEMENT_PROMPT }, { role: 'user', content: `Supplements.${profileContext(user)}` }]
      });
      await sendLong(ctx, r.choices[0].message.content);
    } catch (e) { await ctx.reply('❌ Error. Try again.'); }
    return;
  }
  if (text === '📋 Track Symptoms') {
    session.awaitingSymptoms = true;
    await ctx.reply('📋 Describe your symptoms:');
    return;
  }
  if (text === '📄 Interpret Document') {
    session.awaitingImage = 'document';
    await ctx.reply('📄 Send a photo of your medical document.');
    return;
  }
  if (text === '💬 Health Chat') {
    await ctx.reply('💬 Ask me anything about health!');
    return;
  }
  if (text === '👤 My Profile') {
    await ctx.replyWithMarkdown([
      `👤 *Your Profile*`,
      `Sex: ${user.gender || 'Not set'}`,
      user.pregnancy_status && user.pregnancy_status !== 'not pregnant' ? `Status: ${user.pregnancy_status}` : null,
      `Age: ${user.age || 'Not set'}`,
      `Goal: ${user.goal || 'Not set'}`,
      `\n📊 *Usage*`,
      `Analyses: ${user.analysis_count}/${user.is_pro ? '∞' : FREE_ANALYSIS_LIMIT}`,
      `Chats: ${user.chat_count}/${user.is_pro ? '∞' : FREE_CHAT_LIMIT}`,
      `\n${user.is_pro ? '⭐ *Pro Member*' : `[Upgrade to Pro](${CHECKOUT_URL})`}`
    ].filter(Boolean).join('\n'));
    return;
  }
  if (text === '⭐ Upgrade to Pro') {
    DB.logEvent(ctx.from.id, 'UPGRADE_CLICK', '');
    await ctx.replyWithMarkdown(`⭐ *Metabolic Center Pro — $19/mo*\n\n✦ Unlimited everything\n✦ Priority AI processing\n\n_Founding price locked forever._\n\n👉 [Subscribe Now](${CHECKOUT_URL})`);
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
      messages: [{ role: 'system', content: CHAT_PROMPT + profileContext(user) }, ...session.history]
    });
    const reply = r.choices[0].message.content;
    session.history.push({ role: 'assistant', content: reply });
    await sendLong(ctx, reply);
  } catch (e) {
    console.error('Chat error:', e?.message);
    await ctx.reply('❌ Error. Try again.');
  }
});

// ─── Launch ───
bot.catch((err) => console.error('Bot error:', err));
bot.launch().then(() => console.log('🧬 Metabolic Center Bot is running!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
