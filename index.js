const { Telegraf, Markup } = require('telegraf');
const OpenAI = require('openai');
const https = require('https');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
if (!BOT_TOKEN || !OPENAI_KEY) { console.error('Set BOT_TOKEN and OPENAI_KEY'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ─── Storage ───
const users = {};
const FREE_ANALYSIS_LIMIT = 2;
const FREE_CHAT_LIMIT = 10;
const CHECKOUT_URL = 'https://metaboliccenter.lemonsqueezy.com/checkout/buy/748aab66-5a40-492a-91f6-cda2f844723c';

const DATA_FILE = __dirname + '/users.json';

// Load users from file
try { Object.assign(users, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch(e) {}

function saveUsers() {
  const clean = {};
  for (const [id, u] of Object.entries(users)) {
    clean[id] = { ...u, history: [] }; // don't save chat history to file
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2));
}

function getUser(id) {
  if (!users[id]) users[id] = { analysisCount: 0, chatCount: 0, history: [], joinedAt: new Date().toISOString() };
  return users[id];
}

function logEvent(userId, event, details) {
  const line = `${new Date().toISOString()} | user:${userId} | ${event} | ${details || ''}\n`;
  fs.appendFileSync(__dirname + '/activity.log', line);
  saveUsers();
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

You help with:
- Metabolic health questions
- Nutrition and meal planning
- Supplement recommendations
- Sleep, exercise, stress optimization
- Biomarker interpretation
- Longevity and anti-aging science
- Symptom analysis and pattern detection

Be concise, evidence-based, and actionable. Think precision medicine meets personal coach.
When relevant, mention that uploading blood work gives the best personalized insights.
Respond in user's language. Default English.
End health advice with: "This is AI-generated guidance, not medical advice."`;

const MEAL_PLAN_PROMPT = `You are a precision nutrition AI for Metabolic Center.

Generate a detailed personalized meal plan based on the user's profile and goals.
Include:
- Daily calorie target with macro split
- Breakfast, lunch, dinner, 2 snacks
- Specific foods with portions
- Meal timing recommendations
- Foods to avoid
- Hydration protocol
- Weekly shopping list

Tailor to their goal (energy/longevity/weight/general).
Use sex and age appropriate recommendations.
Respond in user's language.`;

const SUPPLEMENT_PROMPT = `You are a supplement protocol AI for Metabolic Center.

Create a personalized evidence-based supplement protocol.
Include:
- Core supplements (with exact dosages and timing)
- Goal-specific additions
- Interactions to watch for
- Best brands/forms to look for
- Morning vs evening stack
- With food vs empty stomach
- Expected timeline for results
- What to monitor

Be specific with dosages. Cite research when possible.
Tailor to their profile (sex, age, goal).
Respond in user's language.
End with: "Consult your healthcare provider before starting supplements."`;

const SYMPTOM_PROMPT = `You are a symptom analysis AI for Metabolic Center.

When a user describes symptoms:
1. Identify possible metabolic connections
2. Suggest which biomarkers to test
3. Recommend lifestyle adjustments
4. Flag anything that needs urgent medical attention
5. Track patterns if user reports multiple times

Be thorough but not alarming. Focus on actionable steps.
Respond in user's language.
Always end with: "This is not a diagnosis. See a doctor for persistent symptoms."`;

const DOC_PROMPT = `You are a medical document interpreter for Metabolic Center.

When a user sends a medical document (ultrasound, MRI, prescription, etc.):
1. Identify the type of document
2. Explain all findings in simple language
3. Highlight anything abnormal or notable
4. Explain what it means for their health
5. Suggest follow-up actions if needed
6. Connect findings to metabolic health where relevant

Be clear, reassuring, and educational.
Respond in user's language.
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
  const buf = await downloadFile(url);
  return buf.toString('base64');
}

function profileContext(user) {
  if (!user.gender && !user.age) return '';
  let ctx = `\nPatient: ${user.gender || 'unknown sex'}, ${user.age || '?'} years`;
  if (user.pregnancyStatus && user.pregnancyStatus !== 'not pregnant') ctx += `, ${user.pregnancyStatus}`;
  if (user.goal) ctx += `. Goal: ${user.goal}`;
  ctx += '.';
  return ctx;
}

async function sendLong(ctx, text) {
  if (text.length > 4000) {
    const parts = text.match(/[\s\S]{1,4000}/g);
    for (const p of parts) await ctx.replyWithMarkdown(p).catch(() => ctx.reply(p));
  } else {
    await ctx.replyWithMarkdown(text).catch(() => ctx.reply(text));
  }
}

function checkLimit(user, type) {
  if (user.isPro) return true;
  if (type === 'analysis') return user.analysisCount < FREE_ANALYSIS_LIMIT;
  if (type === 'chat') return user.chatCount < FREE_CHAT_LIMIT;
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

*What I can do:*

🔬 *Analyze Blood Tests* — upload a photo, get full metabolic report
🥗 *Meal Plan* — personalized nutrition based on your goals
💊 *Supplement Protocol* — evidence-based supplement stack
📋 *Track Symptoms* — log symptoms, detect patterns
📄 *Interpret Documents* — explain any medical document
💬 *Health Chat* — ask anything about health & longevity

📸 *2 free analyses + 10 free chats to start!*`;

// ─── Start & Profile ───
bot.start(async (ctx) => {
  const user = getUser(ctx.from.id);
  user.step = 'gender';
  logEvent(ctx.from.id, 'START', `@${ctx.from.username || 'no_username'} | ${ctx.from.first_name || ''}`);
  await ctx.replyWithMarkdown(WELCOME, MAIN_MENU);
  setTimeout(() => {
    ctx.reply('First, let me set up your profile for accurate analysis.\n\n👤 Biological sex?', {
      reply_markup: { inline_keyboard: [
        [{ text: '♂️ Male', callback_data: 'gender_male' }, { text: '♀️ Female', callback_data: 'gender_female' }]
      ]}
    });
  }, 1000);
});

const ADMIN_ID = 5309206282; // Тимур

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  const ids = Object.keys(users);
  const total = ids.length;
  const totalAnalyses = ids.reduce((s, id) => s + (users[id].analysisCount || 0), 0);
  const totalChats = ids.reduce((s, id) => s + (users[id].chatCount || 0), 0);
  const proUsers = ids.filter(id => users[id].isPro).length;
  
  const recent = ids
    .sort((a, b) => (users[b].joinedAt || '').localeCompare(users[a].joinedAt || ''))
    .slice(0, 10)
    .map(id => {
      const u = users[id];
      return `• ${u.gender || '?'}, ${u.age || '?'}y, ${u.goal || '?'} — analyses: ${u.analysisCount}, chats: ${u.chatCount} (${u.joinedAt ? u.joinedAt.slice(0,10) : '?'})`;
    }).join('\n');

  await ctx.reply(
`📊 Metabolic Center Stats

👥 Total users: ${total}
⭐ Pro users: ${proUsers}
🔬 Total analyses: ${totalAnalyses}
💬 Total chats: ${totalChats}

📋 Recent users:
${recent || 'No users yet'}`
  );
});

bot.on('callback_query', async (ctx) => {
  const user = getUser(ctx.from.id);
  const data = ctx.callbackQuery.data;

  if (data === 'gender_male' || data === 'gender_female') {
    user.gender = data === 'gender_male' ? 'male' : 'female';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Sex: ${user.gender === 'male' ? 'Male' : 'Female'}`);
    if (user.gender === 'female') {
      user.step = 'pregnant';
      await ctx.reply('🤰 Are you pregnant or breastfeeding?', { reply_markup: { inline_keyboard: [
        [{ text: '🤰 Pregnant', callback_data: 'preg_yes' }],
        [{ text: '🤱 Breastfeeding', callback_data: 'preg_bf' }],
        [{ text: '❌ No', callback_data: 'preg_no' }]
      ]}});
    } else {
      user.step = 'age';
      await ctx.reply('📅 Your age? (type a number)');
    }
  }

  if (data.startsWith('preg_')) {
    user.pregnancyStatus = { preg_yes: 'pregnant', preg_bf: 'breastfeeding', preg_no: 'not pregnant' }[data];
    user.step = 'age';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ ${user.pregnancyStatus === 'not pregnant' ? 'Not pregnant' : user.pregnancyStatus}`);
    await ctx.reply('📅 Your age? (type a number)');
  }

  if (data.startsWith('goal_')) {
    const goals = { goal_energy: 'Energy & Performance', goal_longevity: 'Longevity & Anti-aging', goal_weight: 'Weight Optimization', goal_general: 'General Health' };
    user.goal = goals[data];
    user.step = 'ready';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Goal: ${user.goal}`);
    await ctx.reply('✅ Profile complete! Use the menu below to get started. 👇', MAIN_MENU);
  }
});

// ─── Photo handler (blood test + document) ───
bot.on('photo', async (ctx) => {
  const user = getUser(ctx.from.id);
  
  if (!checkLimit(user, 'analysis')) {
    await ctx.replyWithMarkdown(UPGRADE_MSG);
    return;
  }

  const mode = user.awaitingImage || 'analysis';
  user.awaitingImage = null;

  const prompt = mode === 'document' ? DOC_PROMPT : ANALYSIS_PROMPT;
  const label = mode === 'document' ? '📄 Interpreting document...' : '🔬 Analyzing your blood work... (30-60 sec)';

  await ctx.reply(label);

  try {
    const photos = ctx.message.photo;
    const base64 = await getImageBase64(ctx, photos[photos.length - 1].file_id);
    const caption = ctx.message.caption || '';
    const pCtx = profileContext(user);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4000,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
          { type: 'text', text: `${caption || 'Please analyze this.'}${pCtx}` }
        ]}
      ]
    });

    const result = response.choices[0].message.content;
    user.analysisCount++;
    logEvent(ctx.from.id, 'ANALYSIS', `#${user.analysisCount}`);
    await sendLong(ctx, result);

    const remaining = FREE_ANALYSIS_LIMIT - user.analysisCount;
    if (!user.isPro) {
      if (remaining > 0) {
        await ctx.reply(`📊 Free analyses remaining: ${remaining}/${FREE_ANALYSIS_LIMIT}`);
      } else {
        await ctx.replyWithMarkdown(`📊 That was your last free analysis.\n\n👉 [Upgrade to Pro — $19/mo](${CHECKOUT_URL})`);
      }
    }
  } catch (e) {
    console.error('Image analysis error:', e?.message || e);
    await ctx.reply('❌ Something went wrong. Try again or send a clearer photo.');
  }
});

// ─── Document handler ───
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (doc.mime_type && doc.mime_type.startsWith('image/')) {
    // Forward to photo handler logic
    const user = getUser(ctx.from.id);
    if (!checkLimit(user, 'analysis')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    
    await ctx.reply('🔬 Analyzing... (30-60 sec)');
    try {
      const base64 = await getImageBase64(ctx, doc.file_id);
      const pCtx = profileContext(user);
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 4000,
        messages: [
          { role: 'system', content: ANALYSIS_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
            { type: 'text', text: `Analyze this.${pCtx}` }
          ]}
        ]
      });
      user.analysisCount++;
      await sendLong(ctx, response.choices[0].message.content);
    } catch (e) {
      console.error('Doc error:', e?.message);
      await ctx.reply('❌ Error. Try sending as a photo instead.');
    }
  } else {
    await ctx.reply('📄 Send medical documents as photos (JPG/PNG) for best results.');
  }
});

// ─── Text handler (menu + chat) ───
bot.on('text', async (ctx) => {
  const user = getUser(ctx.from.id);
  const text = ctx.message.text.trim();

  // Onboarding: age input
  if (user.step === 'age') {
    const age = parseInt(text);
    if (age > 0 && age < 120) {
      user.age = age;
      user.step = 'goal';
      await ctx.reply(`✅ Age: ${age}\n\n🎯 Primary health goal?`, { reply_markup: { inline_keyboard: [
        [{ text: '⚡ Energy & Performance', callback_data: 'goal_energy' }],
        [{ text: '🧬 Longevity & Anti-aging', callback_data: 'goal_longevity' }],
        [{ text: '⚖️ Weight Optimization', callback_data: 'goal_weight' }],
        [{ text: '💚 General Health', callback_data: 'goal_general' }]
      ]}});
    } else {
      await ctx.reply('Enter a valid age (1-119).');
    }
    return;
  }

  // Symptom tracking input
  if (user.awaitingSymptoms) {
    user.awaitingSymptoms = false;
    if (!checkLimit(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chatCount++;
    
    // Store symptom
    if (!user.symptoms) user.symptoms = [];
    user.symptoms.push({ date: new Date().toISOString(), text });
    
    await ctx.reply('🔍 Analyzing symptoms...');
    try {
      const symptomHistory = user.symptoms.map(s => `${s.date.slice(0,10)}: ${s.text}`).join('\n');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 2000,
        messages: [
          { role: 'system', content: SYMPTOM_PROMPT },
          { role: 'user', content: `${profileContext(user)}\n\nSymptom history:\n${symptomHistory}\n\nLatest symptoms: ${text}` }
        ]
      });
      await sendLong(ctx, response.choices[0].message.content);
    } catch (e) {
      console.error('Symptom error:', e?.message);
      await ctx.reply('❌ Error. Try again.');
    }
    return;
  }

  // ─── Menu buttons ───
  if (text === '🔬 Analyze Blood Test') {
    await ctx.reply('📸 Send a photo of your blood test results.');
    return;
  }

  if (text === '🥗 Meal Plan') {
    if (!checkLimit(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chatCount++;
    await ctx.reply('🥗 Generating your personalized meal plan...');
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 3000,
        messages: [
          { role: 'system', content: MEAL_PLAN_PROMPT },
          { role: 'user', content: `Create a personalized weekly meal plan.${profileContext(user)}` }
        ]
      });
      await sendLong(ctx, response.choices[0].message.content);
    } catch (e) {
      console.error('Meal error:', e?.message);
      await ctx.reply('❌ Error generating meal plan. Try again.');
    }
    return;
  }

  if (text === '💊 Supplement Protocol') {
    if (!checkLimit(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
    user.chatCount++;
    await ctx.reply('💊 Building your supplement protocol...');
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', max_tokens: 3000,
        messages: [
          { role: 'system', content: SUPPLEMENT_PROMPT },
          { role: 'user', content: `Create a personalized supplement protocol.${profileContext(user)}` }
        ]
      });
      await sendLong(ctx, response.choices[0].message.content);
    } catch (e) {
      console.error('Supplement error:', e?.message);
      await ctx.reply('❌ Error. Try again.');
    }
    return;
  }

  if (text === '📋 Track Symptoms') {
    user.awaitingSymptoms = true;
    await ctx.reply('📋 Describe your symptoms (what you feel, when it started, severity):');
    return;
  }

  if (text === '📄 Interpret Document') {
    user.awaitingImage = 'document';
    await ctx.reply('📄 Send a photo of your medical document (ultrasound, MRI report, prescription, etc.)');
    return;
  }

  if (text === '💬 Health Chat') {
    await ctx.reply('💬 Ask me anything about health, nutrition, longevity, or metabolic optimization. Just type your question!');
    return;
  }

  if (text === '👤 My Profile') {
    const p = user;
    const profile = [
      `👤 *Your Profile*`,
      `Sex: ${p.gender || 'Not set'}`,
      p.pregnancyStatus && p.pregnancyStatus !== 'not pregnant' ? `Status: ${p.pregnancyStatus}` : null,
      `Age: ${p.age || 'Not set'}`,
      `Goal: ${p.goal || 'Not set'}`,
      ``,
      `📊 *Usage*`,
      `Analyses: ${p.analysisCount}/${p.isPro ? '∞' : FREE_ANALYSIS_LIMIT}`,
      `Chat queries: ${p.chatCount}/${p.isPro ? '∞' : FREE_CHAT_LIMIT}`,
      p.symptoms ? `Symptom logs: ${p.symptoms.length}` : null,
      ``,
      p.isPro ? '⭐ *Pro Member*' : `_Free plan — [Upgrade to Pro](${CHECKOUT_URL})_`
    ].filter(Boolean).join('\n');
    await ctx.replyWithMarkdown(profile);
    return;
  }

  if (text === '⭐ Upgrade to Pro') {
    logEvent(ctx.from.id, 'UPGRADE_CLICK', '');
    await ctx.replyWithMarkdown(`⭐ *Metabolic Center Pro — $19/mo*\n\n✦ Unlimited blood test analyses\n✦ Unlimited AI health chat\n✦ Personalized meal plans\n✦ Supplement protocols\n✦ Symptom tracking & patterns\n✦ Medical document interpretation\n✦ Priority processing\n\n_Founding price locked forever. Future: $79/mo._\n\n👉 [Subscribe Now](${CHECKOUT_URL})`);
    return;
  }

  // ─── General health chat ───
  if (!checkLimit(user, 'chat')) { await ctx.replyWithMarkdown(UPGRADE_MSG); return; }
  user.chatCount++;

  try {
    // Keep last 6 messages for context
    user.history.push({ role: 'user', content: text });
    if (user.history.length > 6) user.history = user.history.slice(-6);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 1500,
      messages: [
        { role: 'system', content: CHAT_PROMPT + profileContext(user) },
        ...user.history
      ]
    });

    const reply = response.choices[0].message.content;
    user.history.push({ role: 'assistant', content: reply });
    await sendLong(ctx, reply);
  } catch (e) {
    console.error('Chat error:', e?.message);
    await ctx.reply('❌ Something went wrong. Try again.');
  }
});

// ─── Launch ───
bot.catch((err) => console.error('Bot error:', err));
bot.launch().then(() => console.log('🧬 Metabolic Center Bot is running!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
