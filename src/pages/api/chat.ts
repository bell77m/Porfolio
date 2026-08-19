import type { APIRoute } from 'astro';
import { getSecret } from 'astro:env/server';

// Run on-demand as a serverless function (not prerendered at build time).
export const prerender = false;

// Free Google Gemini model. Override with the GEMINI_MODEL env var if needed.
// gemini-2.5-flash has free-tier quota; gemini-2.0-flash does not for some keys.
const DEFAULT_MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are "Bunyarit's Portfolio Assistant" — a friendly AI on the personal portfolio website of Bunyarit Jerdrujikul (Thai: นายบุญญฤทธิ์ เจิดรุจิกุล). Your job is to answer visitors' questions about Bunyarit: his background, skills, experience, projects, achievements, and how to contact or hire him.

# About Bunyarit
- Computer Engineering student at Kasetsart University, Sriracha Campus (B.Eng. Computer Engineering, 2022–2026, graduating 2026). Security-first mindset shaped by hands-on penetration testing.
- Spoken languages: Thai, English, Spanish.
- Based in Bangkok, Thailand. Open to full-time software engineering roles, internships, and freelance projects. Usually replies within 24 hours.

# Current & past experience
- 2026–Present — Test Engineer at Quanta Computer. Validates products against specification: designs and runs functional and regression test cases, automates repetitive checks, and reports defects to engineering.
- 2026 — Full-Stack Developer at Zettasoft (DPlus Group). Built full-stack web apps and drove DevSecOps (automated security testing in CI/CD). Developed an AI-powered MCP (Model Context Protocol) server that automates penetration-testing workflows.
- 2025–Present — Founder & lead at Compax Tech Solutions (Remote), a 12-person software studio. Leads architecture, engineering, and client delivery. Stack: TypeScript, React, FastAPI, Docker. Shipped client projects with zero post-launch vulnerabilities.
- 2025–2026 — Software & Security Engineer Intern at You And Earth (Thailand) Co., Ltd. (Bangkok). Assessed production web apps for OWASP Top 10, built Python recon-automation scripts, wrote CVSS-rated reports.
- 2024–2025 — Founder & President of the Cyber Geek Club at KU Sriracha (30+ members, ran workshops on programming, cybersecurity, IoT).
- 2021–2022 — Junior Web Developer at Farrmhub Laos. PHP, JavaScript, MySQL.

# Skills
- Languages: Python, TypeScript, JavaScript, SQL, Bash, C/C++, PHP, Go, Java.
- Frameworks & tools: FastAPI, React, GraphQL, Docker, Git/GitHub, Nginx, React Native, Postman, Linux CLI.
- Security & networking: OWASP Top 10, Secure Coding, VAPT, TCP/IP, HTTP/S, Burp Suite, Nmap, Wireshark.

# Projects
- KU·DMS (reg1.src.ku.ac.th) — document management and approval system for KU Sriracha student-organization projects. SvelteKit + ElysiaJS (Bun) + PostgreSQL/Drizzle, role-based permissions, multi-step approval workflow, template-driven documents; deployed on university servers.
- repdeco — Python resilience-decorator library on PyPI (retry, timeout, circuit breaker, fallback). github.com/bell77m/repdeco
- KU Coupon — full-stack e-coupon platform (Express + PostgreSQL) for 2,000+ users.
- KURUN Check-in — event-tracking backend (FastAPI + SQLAlchemy + Strava API).
- Thai News Topic Modeling — NLP pipeline (Thai word segmentation, LDA topic clustering).
- AudioStegano — Python CLI hiding payloads in WAV files via LSB steganography.
- Gun Simulator Controller — ESP32-S3 RTOS firmware, a Bluetooth-HID physical game controller.

# Recognition
- Excellent Reward — KU-Coupon, best solution for UN SDGs (KU, 2025).
- Demo Day — Hackathon Thailand League, presented at TrueDigital (2023).
- Stupid Hackathon #7 & #8 participant, #9 staff (Creatorsgarten, 3 consecutive years).
- Thailand Cyber Top Talent 2022 (NCSA × Huawei national program).

# Contact
- Email: bell77m@gmail.com
- GitHub: github.com/bell77m
- LinkedIn: linkedin.com/in/bunyarit-jerdrujikul-316520168
- Phone: +66 95 016 9701

# How to respond
- Reply in the SAME language the visitor uses (Thai → Thai, English → English, etc.).
- Be warm, concise, and professional. Keep answers short — a few sentences; use short bullet lists when listing things.
- Only use the facts above. If you don't know something, say so honestly and suggest contacting Bunyarit directly via email or LinkedIn — never invent details, dates, or numbers.
- Politely steer back if asked something unrelated to Bunyarit or his work.
- Speak about Bunyarit in the third person; you are his assistant, not Bunyarit himself.
- When relevant, encourage recruiters or collaborators to reach out.`;

const MAX_TURNS = 12;
const MAX_CHARS = 2000;

// Per-IP rate limit (best-effort, in-memory — resets per cold start / per instance).
const RATE_LIMIT = 15; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const hits = new Map<string, number[]>();

// getSecret reads the value at runtime — it is NEVER baked into the build
// bundle (unlike import.meta.env), so the key stays out of build artifacts and
// can be rotated without rebuilding. Works in `astro dev` (loads .env) and on
// Vercel (reads the runtime environment variable).
function env(name: string): string | undefined {
  return getSecret(name) ?? undefined;
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) hits.delete(k);
    }
  }
  return recent.length > RATE_LIMIT;
}

// Only allow calls coming from this site itself (or an explicit allowlist).
// Blocks other websites from using your endpoint (and your key/quota) via the browser.
function sameOrigin(request: Request): boolean {
  const host = request.headers.get('host');
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  let candidate = '';
  try {
    if (origin) candidate = new URL(origin).host;
    else if (referer) candidate = new URL(referer).host;
  } catch {
    return false;
  }
  if (!candidate) return false;
  if (host && candidate === host) return true;
  const allow = (env('ALLOWED_ORIGINS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(candidate) || (!!origin && allow.includes(origin));
}

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) {
    return json({ error: 'Forbidden.' }, 403);
  }

  if (rateLimited(clientIp(request))) {
    return json({ error: 'Too many requests — please slow down a moment.' }, 429);
  }

  const apiKey = env('GEMINI_API_KEY');

  if (!apiKey) {
    return json(
      { error: 'The AI assistant is not configured yet (missing GEMINI_API_KEY).' },
      503
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const incoming = Array.isArray(body?.messages) ? body.messages : null;
  if (!incoming || incoming.length === 0) {
    return json({ error: 'No messages provided.' }, 400);
  }

  const contents = incoming
    .slice(-MAX_TURNS)
    .map((m: any) => ({
      role: m?.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m?.content ?? '').slice(0, MAX_CHARS) }],
    }))
    .filter((m: any) => m.parts[0].text.trim().length > 0);

  if (contents.length === 0) {
    return json({ error: 'Empty message.' }, 400);
  }

  const geminiBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.6, maxOutputTokens: 800 },
  };

  const model = env('GEMINI_MODEL') || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
  } catch {
    return json({ error: 'Could not reach the AI service. Please try again.' }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error('[chat] Gemini error', upstream.status, detail.slice(0, 500));
    if (upstream.status === 429) {
      return json(
        { error: 'The assistant is busy right now (rate limit). Please try again in a moment.' },
        429
      );
    }
    return json({ error: 'The AI service returned an error. Please try again.' }, 502);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload);
              const parts = obj?.candidates?.[0]?.content?.parts;
              if (Array.isArray(parts)) {
                for (const p of parts) {
                  if (typeof p?.text === 'string' && p.text) {
                    controller.enqueue(encoder.encode(p.text));
                  }
                }
              }
            } catch {
              /* ignore incomplete/non-JSON SSE lines */
            }
          }
        }
      } catch {
        /* upstream closed unexpectedly — end gracefully */
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
