/*
Project Rules:
1. Do not change working code unless explicitly instructed.
2. Use modular design to isolate new features.
3. Save known-good checkpoints before making changes.
4. Provide diffs (only changed/added lines) when possible instead of full rewrites.
5. Help verify key features still work.
*/

require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Club member emails, comma-separated
const clubMembers = process.env.CLUB_MEMBERS ? process.env.CLUB_MEMBERS.split(',') : [];
const initialDelay = 2000;
const spinDelay = 2200;
const frameInterval = Math.floor(1000 / 60);

// Increase JSON body size to handle base64 images
app.use(express.json({ limit: '10mb' }));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Email transporter
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

// In-memory user registrations (or load from a JSON file)
const registrationsFile = path.join(__dirname, 'registrations.json');
let registrations = [];

// Load existing registrations if file exists
if (fs.existsSync(registrationsFile)) {
  registrations = JSON.parse(fs.readFileSync(registrationsFile, 'utf-8'));
}

// Serve signup page at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));

// Serve main Puddy Pictures Picker at /app
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Register user route
app.post('/api/register-user', express.urlencoded({ extended: true }), (req, res) => {
  const { name, phone, consent } = req.body;
  if (!name || !phone || consent !== 'yes') {
    return res.status(400).send('Missing required fields or consent not given.');
  }

  const newRegistration = { name, phone, consent: true, date: new Date().toISOString() };
  registrations.push(newRegistration);

  // Persist to file
  fs.writeFileSync(registrationsFile, JSON.stringify(registrations, null, 2));

  // Send welcome SMS via Twilio
  twilioClient.messages.create({
    from: twilioFrom,
    to: phone,
    body: `Hi ${name}, thanks for joining the Puddy Pictures Movie Club! Reply STOP anytime to opt out.`
  }).then(() => {
    console.log(`Confirmation SMS sent to ${phone}`);
  }).catch(err => {
    console.error('Error sending SMS:', err);
  });

  res.send('Thanks for joining! You’ll receive a welcome SMS shortly.');
});

// Record spinning wheels video
async function recordSpinVideo(selections, outputPath) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3000');
  await page.waitForTimeout(initialDelay);
  let frameCount = 0;
  const captureInterval = setInterval(async () => {
    await page.screenshot({ path: `frame${String(frameCount).padStart(4, '0')}.png` });
    frameCount++;
  }, frameInterval);
  for (const key of ['region', 'genre', 'decade', 'budget']) {
    await page.select(`#${key}-select`, selections[key]);
    await page.waitForTimeout(spinDelay);
  }
  await page.waitForTimeout(1000);
  clearInterval(captureInterval);
  await browser.close();
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-r', '60', '-i', 'frame%04d.png',
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
      outputPath
    ]);
    ffmpeg.on('exit', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`)));
  });
}

// Email video to members
async function sendVideoEmail(videoPath, movieInfo) {
  if (!clubMembers.length) return;
  await emailTransporter.sendMail({
    from: process.env.SMTP_USER,
    to: clubMembers,
    subject: `Puddy Pictures Reveal: ${movieInfo.title}`,
    text: `Our pick: ${movieInfo.title}\n${movieInfo.watch_info}`,
    attachments: [{ filename: 'reveal.mp4', path: videoPath }]
  });
}

// Main movie generation endpoint
app.post('/api/generate-movie', async (req, res) => {
  // ... existing generate-movie implementation (unchanged) ...
});

// Endpoint to receive and dispatch results via email or Twilio
app.post('/api/send-results', async (req, res) => {
  console.log('Received send-results request with contacts:', req.body.contacts);
  const { contacts, image, posterUrl } = req.body;
  const buffer = Buffer.from(image.split(',')[1], 'base64');
  const results = [];

  for (const contact of contacts) {
    try {
      if (/@/.test(contact)) {
        // Send via email
        console.log(`Sending email to ${contact}`);
        await emailTransporter.sendMail({
          from: process.env.SMTP_USER,
          to: contact,
          subject: 'Puddy Pictures Result',
          text: 'Here is the movie pick result!',
          attachments: [{ filename: 'result.png', content: buffer }]
        });
        results.push({ contact, status: 'email sent' });
      } else {
        // Send SMS/MMS via Twilio
        const msgOptions = {
          to: contact,
          from: twilioFrom,
          body: 'Check out our movie pick:'
        };
        if (posterUrl && posterUrl.startsWith('https://')) {
          msgOptions.mediaUrl = [posterUrl];
        }
        console.log(`Sending SMS via Twilio to ${contact}`);
        await twilioClient.messages.create(msgOptions);
        results.push({ contact, status: 'sms sent' });
      }
    } catch (err) {
      console.error(`Error sending to ${contact}:`, err);
      results.push({ contact, status: 'error', error: err.message });
    }
  }

  res.json({ results });
});

// 404 fallback
app.use((_, res) => res.status(404).send('Not Found'));

// Start server
app.listen(port, () => console.log(`Server listening at http://localhost:${port}`));
