// Copy to config.js and fill in real values (config.js is in .gitignore).
// Turn off any platform with enabled: false. See doc/deploy.md for how to get each value.
export default {
  douban: {
    enabled: true,
    api: {
      key: '',        // Frodo apikey
      secret: '',     // Frodo secret, used to sign requests
      device: {       // The Android device we pretend to be. Copy from a real phone's traffic
        sdkInt: 29,
        product: '',
        manufacturer: '',
        model: '',
        id: '',       // udid: any stable hex string
        doubanId: ''  // douban_udid: required by newer app versions
      }
    },
    username: '',     // Douban login (email or phone)
    password: ''
  },

  // The top level is the main Chinese account (脆脆大笨钟). Other languages go in `accounts`
  // at the bottom and share the same Meta app
  threads: {
    enabled: true,
    appId: '',        // Meta dashboard: Use cases → Customize → Settings → Threads app ID
    appSecret: '',    // Same page: Threads app secret (needed to refresh tokens)
    accessToken: '',  // Same page, bottom: User Token Generator → Generate Access Token
    userId: '',       // Optional. Empty = /me
    username: '',     // Optional. If set, startup checks that the token belongs to this account (posts nothing if not)
    // Only for npm run threads:auth. Must exactly match the Redirect Callback URL in the dashboard
    redirectUri: '',

    // Optional: reply with the current time when someone @mentions you. Needs threads_manage_mentions.
    // Without Advanced Access you only see mentions from Threads testers (0 in the log is normal)
    mentions: {
      enabled: false,
      pollSeconds: 60,          // Poll interval = worst-case reply delay (min 15)
      maxAgeMinutes: 30,        // Skip older mentions, so a day offline doesn't flood replies
      userCooldownSeconds: 120, // Per-user cooldown
      dailyCap: 200             // Daily limit for this feature (hard limit: see replyQuotaHeadroom)
    },

    // Optional: reply to comments under your posts. Time questions get the time; the rest goes to `ai`.
    // Needs threads_read_replies. No Advanced Access limit: replies from strangers work too
    reply: {
      enabled: false,           // Try REPLY_DRY_RUN=1 first (doc/deploy.md)
      pollSeconds: 60,          // Poll interval (min 15)
      lookbackHours: 3,         // Only check your posts from the last N hours (1–48)
      maxAgeMinutes: 30,        // Skip older comments
      userCooldownSeconds: 60,  // Per-user cooldown
      dailyCap: 300,            // Daily limit for this feature
      maxTextLength: 480,       // Cut replies to this length (Threads max is 500)
      // Earlier messages in the thread to give the AI, so it can tell whether "ok" ends
      // a chat or starts one. 0–8, 0 = off. Free-tier models do worse with more
      contextMessages: 4
    },

    // Both reply features share Threads' pool of 1000 replies / 24h. Keep this many free for manual use.
    // The real limit is "server-side usage vs 1000 - this" (platforms/threads/quota.js).
    // Hourly posts don't use this pool: posts have their own 250 / 24h
    replyQuotaHeadroom: 100,

    // Accounts for other languages. The key is the language (en / es / fr, text in lib/locales/)
    // and the platform name suffix: en → threads-en, token in data/threads-en-token.json.
    // appId / appSecret / redirectUri come from above. mentions / reply are main account only.
    // Add each account as a Threads Tester, then get its own token (doc/deploy.md)
    accounts: {
      en: { enabled: false, accessToken: '', username: '' },   // London time, BONG
      es: { enabled: false, accessToken: '', username: '' },   // Mexico City time, ¡Dong!
      fr: { enabled: false, accessToken: '', username: '' }    // Paris time, Dong !
    }
  },

  mastodon: {
    enabled: true,
    instance: 'https://m.cmx.im',
    accessToken: '',  // Preferences → Development → New application, scope write:statuses
    // Other languages, same rules as threads.accounts (mastodon-en etc.). Each can use its own instance:
    //   en: { enabled: true, instance: 'https://...', accessToken: '' }
    accounts: {}
  },

  // Model for comment replies. Only used when threads.reply.enabled is true.
  // To add a fallback, write a module like services/gemini.js and add it to PROVIDERS in services/ai.js
  ai: {
    gemini: {
      enabled: true,
      apiKey: '',                       // https://aistudio.google.com/apikey (free tier is enough)
      model: 'gemini-3.5-flash-lite',   // Empty = default. A wrong name returns 404
      timeoutMs: 20000,
      // Passed to Gemini as is. Change it only to turn off "thinking" and save quota:
      // 2.5 models { thinkingConfig: { thinkingBudget: 0 } }, 3.x models { thinkingConfig: { thinkingLevel: 'low' } }
      generationConfig: {}
    }
  }
};
