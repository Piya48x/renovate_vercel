const express = require('express');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));

const LINE_PUSH_API = process.env.LINE_PUSH_API || 'https://api.line.me/v2/bot/message/push';
const FB_GRAPH_API = process.env.FB_GRAPH_API || 'https://graph.facebook.com/v22.0';

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const ALLOWED_ORIGINS = parseCsv(process.env.ALLOWED_ORIGINS);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGINS.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.static(path.join(__dirname)));

const formatBangkokTime = () => {
  try {
    return new Intl.DateTimeFormat('th-TH', {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: 'Asia/Bangkok'
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
};

const truncateText = (value, maxLength) => {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

const buildBookingMessage = (body) => {
  if (body.raw_message) return String(body.raw_message).trim();
  const lines = [
    'แจ้งเตือนนัดหมายใหม่ (เว็บไซต์)',
    'สถานะ: รอติดต่อกลับ',
    'คำขอ: กรุณาให้ทีมงานติดต่อกลับลูกค้าเพื่อยืนยันคิว',
    `ผู้ติดต่อ: ${body.name || '-'}`,
    `เบอร์โทร: ${body.phone || '-'}`,
    `บริการ: ${body.service || '-'}`,
    `วันเวลา: ${body.date || '-'} ${body.time || '-'}`,
    `พื้นที่: ${body.area || '-'}`,
    `รายละเอียด: ${body.note || '-'}`,
    `เวลาที่ส่ง: ${formatBangkokTime()}`
  ];
  return lines.join('\n');
};

const summarizeError = (error) => {
  if (!error) return 'unknown-error';
  const responseData = error.response?.data;
  if (typeof responseData === 'string' && responseData) return responseData;
  if (responseData && typeof responseData === 'object') return JSON.stringify(responseData);
  return error.message || String(error);
};

const sendLinePush = async ({ channelToken, targets, text }) => {
  const safeText = truncateText(text, 4500);
  const jobs = targets.map(async (to) => {
    try {
      const response = await axios.post(
        LINE_PUSH_API,
        {
          to,
          messages: [{ type: 'text', text: safeText }]
        },
        {
          headers: {
            Authorization: `Bearer ${channelToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );
      return { channel: 'line', target: to, ok: response.status >= 200 && response.status < 300 };
    } catch (error) {
      return { channel: 'line', target: to, ok: false, error: summarizeError(error) };
    }
  });
  return Promise.all(jobs);
};

const sendFacebookInbox = async ({ pageAccessToken, recipients, text }) => {
  const safeText = truncateText(text, 1800);
  const endpoint = `${FB_GRAPH_API}/me/messages`;
  const jobs = recipients.map(async (psid) => {
    try {
      const response = await axios.post(
        endpoint,
        {
          recipient: { id: psid },
          messaging_type: 'UPDATE',
          message: { text: safeText }
        },
        {
          params: { access_token: pageAccessToken },
          timeout: 8000
        }
      );
      return { channel: 'facebook', target: psid, ok: response.status >= 200 && response.status < 300 };
    } catch (error) {
      return { channel: 'facebook', target: psid, ok: false, error: summarizeError(error) };
    }
  });
  return Promise.all(jobs);
};

app.post('/api/booking-notify', async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({
      ok: false,
      error: 'unsupported-content-type',
      expected: 'application/json'
    });
  }

  const body = req.body || {};
  const message = buildBookingMessage(body);

  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const lineTargets = parseCsv(process.env.LINE_TO_IDS);
  const fbToken = process.env.FB_PAGE_ACCESS_TOKEN || '';
  const fbRecipients = parseCsv(process.env.FB_RECIPIENT_PSIDS);

  const missing = [];
  if (!lineToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (!lineTargets.length) missing.push('LINE_TO_IDS');
  if (!fbToken) missing.push('FB_PAGE_ACCESS_TOKEN');
  if (!fbRecipients.length) missing.push('FB_RECIPIENT_PSIDS');

  if (missing.length) {
    return res.status(500).json({
      ok: false,
      error: 'missing-config',
      missing
    });
  }

  try {
    const [lineResults, fbResults] = await Promise.all([
      sendLinePush({ channelToken: lineToken, targets: lineTargets, text: message }),
      sendFacebookInbox({ pageAccessToken: fbToken, recipients: fbRecipients, text: message })
    ]);

    const allResults = [...lineResults, ...fbResults];
    const failed = allResults.filter((item) => !item.ok);
    const lineSuccess = lineResults.filter((item) => item.ok).length;
    const facebookSuccess = fbResults.filter((item) => item.ok).length;

    // Business rule: if LINE is delivered, treat request as success.
    if (lineSuccess > 0) {
      return res.status(200).json({
        ok: true,
        lineDelivered: true,
        facebookDelivered: failed.length ? facebookSuccess > 0 : true,
        sent: allResults.length - failed.length,
        total: allResults.length,
        failed
      });
    }

    return res.status(502).json({
      ok: false,
      error: 'line-delivery-required',
      failed,
      sent: allResults.length - failed.length,
      total: allResults.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'internal-error',
      detail: summarizeError(error)
    });
  }
});

app.post('/api/line-webhook', (req, res) => {
  const payload = req.body || {};
  console.log('[line-webhook] payload:', JSON.stringify(payload, null, 2));

  const ids = new Set();
  const events = Array.isArray(payload.events) ? payload.events : [];
  events.forEach((event) => {
    const source = event?.source || {};
    if (source.userId) ids.add(source.userId);
    if (source.groupId) ids.add(source.groupId);
    if (source.roomId) ids.add(source.roomId);
  });
  if (ids.size) {
    console.log(`[line-webhook] LINE_TO_IDS=${Array.from(ids).join(',')}`);
  }

  return res.sendStatus(200);
});

app.get('/api/config-check', (req, res) => {
  res.json({
    ok: true,
    config: {
      lineToken: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      lineTargets: parseCsv(process.env.LINE_TO_IDS).length,
      fbToken: Boolean(process.env.FB_PAGE_ACCESS_TOKEN),
      fbRecipients: parseCsv(process.env.FB_RECIPIENT_PSIDS).length
    }
  });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json({
      ok: false,
      error: 'invalid-json'
    });
  }
  return next(error);
});

app.get('/health', (req, res) => res.json({ ok: true }));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
