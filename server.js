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
const fs = require('fs');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
const port = process.env.PORT || 3000;
const registrationsFile = path.join(__dirname, 'registrations.json');

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));
// Parse URL-encoded form bodies (for signup.html)
app.use(express.urlencoded({ extended: true }));

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Email transporter
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

// Serve frontend pages
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/signup-success.html', (req, res) => res.sendFile(path.join(__dirname, 'signup-success.html')));

// Handle new registrations
app.post('/api/register-user', (req, res) => {
  const { name, phone, consent } = req.body;
  if (!consent) {
    return res.status(400).send('Consent required to register.');
  }

  let registrations = [];
  if (fs.existsSync(registrationsFile)) {
    registrations = JSON.parse(fs.readFileSync(registrationsFile, 'utf-8'));
  }

  registrations.push({
    name,
    phone,
    consent: true,
    date: new Date().toISOString()
  });

  fs.writeFileSync(
    registrationsFile,
    JSON.stringify(registrations, null, 2),
    'utf-8'
  );

  return res.redirect('/signup-success.html');
});

// ← ADDED: Return the current registrations array to callers (e.g., weekly-sms job)
app.get('/api/contacts', (_req, res) => {
  let registrations = [];
  if (fs.existsSync(registrationsFile)) {
    registrations = JSON.parse(fs.readFileSync(registrationsFile, 'utf-8'));
  }
  res.json(registrations);
});

// Utility: record spin video using Puppeteer + FFmpeg
async function recordSpinVideo(selections, outputPath) {
  const initialDelay = 2000;
  const spinDelay = 2200;
  const frameInterval = Math.floor(1000 / 60);

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:' + port);
  await page.waitForTimeout(initialDelay);

  let frameCount = 0;
  const captureInterval = setInterval(async () => {
    await page.screenshot({ path: `frame${String(frameCount).padStart(4,'0')}.png` });
    frameCount++;
  }, frameInterval);

  for (const key of ['region','genre','decade','budget']) {
    await page.select(`#${key}-select`, selections[key]);
    await page.waitForTimeout(spinDelay);
  }

  await page.waitForTimeout(1000);
  clearInterval(captureInterval);
  await browser.close();

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-r', '60',
      '-i', 'frame%04d.png',
      '-c:v', 'libx264',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      outputPath
    ]);
    ffmpeg.on('exit', code => {
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg exited ${code}`));
    });
  });
}

// Utility: send reveal video via email to club members
async function sendVideoEmail(videoPath, movieInfo) {
  const clubMembers = process.env.CLUB_MEMBERS
    ? process.env.CLUB_MEMBERS.split(',')
    : [];
  if (!clubMembers.length) return;

  await emailTransporter.sendMail({
    from: process.env.SMTP_USER,
    to: clubMembers,
    subject: `Puddy Pictures Reveal: ${movieInfo.title}`,
    text: `Our pick: ${movieInfo.title}\n${movieInfo.watch_info}`,
    attachments: [
      { filename: 'reveal.mp4', path: videoPath }
    ]
  });
}

// Full mappings for movie generation
const regionCountries = {
  'North America': ['United States','USA','Canada','Mexico','Greenland','Bermuda','Saint Pierre and Miquelon'],
  'Europe': ['Albania','Andorra','Armenia','Austria','Azerbaijan','Belarus','Belgium','Bosnia and Herzegovina','Bulgaria','Croatia','Cyprus','Czech Republic','Denmark','Estonia','Finland','France','Georgia','Germany','Greece','Hungary','Iceland','Ireland','Italy','Kazakhstan','Kosovo','Latvia','Liechtenstein','Lithuania','Luxembourg','Malta','Moldova','Monaco','Montenegro','Netherlands','North Macedonia','Norway','Poland','Portugal','Romania','Russia','San Marino','Serbia','Slovakia','Slovenia','Spain','Sweden','Switzerland','Turkey','Ukraine','United Kingdom','UK','Vatican City'],
  'Asia': ['Afghanistan','Armenia','Azerbaijan','Bahrain','Bangladesh','Bhutan','Brunei','Cambodia','China','Cyprus','East Timor','Timor-Leste','Georgia','India','Indonesia','Iran','Iraq','Israel','Japan','Jordan','Kazakhstan','Kuwait','Kyrgyzstan','Laos','Lebanon','Malaysia','Maldives','Mongolia','Myanmar','Burma','Nepal','North Korea','Oman','Pakistan','Palestine','Philippines','Qatar','Russia','Saudi Arabia','Singapore','South Korea','Sri Lanka','Syria','Taiwan','Tajikistan','Thailand','Turkey','Turkmenistan','United Arab Emirates','Uzbekistan','Vietnam','Yemen'],
  'Latin America': ['Mexico','Belize','Costa Rica','El Salvador','Guatemala','Honduras','Nicaragua','Panama','Cuba','Dominican Republic','Haiti','Jamaica','Puerto Rico','Argentina','Bolivia','Brazil','Chile','Colombia','Ecuador','Guyana','Paraguay','Peru','Suriname','Uruguay','Venezuela','Trinidad and Tobago','Barbados','Bahamas','Grenada','St. Lucia','Antigua and Barbuda','St. Kitts and Nevis','Dominica','St. Vincent and the Grenadines'],
  'Africa': ['Algeria','Angola','Benin','Botswana','Burkina Faso','Burundi','Cabo Verde','Cameroon','Central African Republic','Chad','Comoros','Democratic Republic of the Congo','Republic of the Congo','Djibouti','Egypt','Equatorial Guinea','Eritrea','Eswatini','Ethiopia','Gabon','Gambia','Ghana','Guinea','Guinea-Bissau','Ivory Coast','Kenya','Lesotho','Liberia','Libya','Madagascar','Malawi','Mali','Mauritania','Mauritius','Morocco','Mozambique','Namibia','Niger','Nigeria','Rwanda','Sao Tome and Principe','Senegal','Seychelles','Sierra Leone','Somalia','South Africa','South Sudan','Sudan','Tanzania','Togo','Tunisia','Uganda','Zambia','Zimbabwe'],
  'Oceania': ['Australia','New Zealand','Fiji','Papua New Guinea','Samoa','Solomon Islands','Tonga','Vanuatu','Micronesia','Palau','Marshall Islands','Kiribati','Nauru','Tuvalu']
};
const budgetRanges = {
  'Micro-budget': '< $100k',
  'Indie': '$100k - $10M',
  'Studio': '$10M - $50M',
  'Blockbuster': '> $50M'
};
const genreList = ['Drama','Comedy','Horror','Action','Sci-Fi','Romance','Thriller','Animation','Documentary'];
const decadeList = ['1950s','1960s','1970s','1980s','1990s','2000s','2010s','2020s'];

// Main movie generation endpoint
app.post('/api/generate-movie', async (req, res) => {
  let { region, genre, decade, budget } = req.body;

  // Fallback to random if missing
  if (!region) {
    const regions = Object.keys(regionCountries);
    region = regions[Math.floor(Math.random() * regions.length)];
  }
  if (!genre) {
    genre = genreList[Math.floor(Math.random() * genreList.length)];
  }
  if (!decade) {
    decade = decadeList[Math.floor(Math.random() * decadeList.length)];
  }
  if (!budget) {
    const budgets = Object.keys(budgetRanges);
    budget = budgets[Math.floor(Math.random() * budgets.length)];
  }

  const prompt = `You are a helpful assistant that suggests a movie strictly based on:\n` +
    `- Region: ${region}\n` +
    `- Genre: ${genre}\n` +
    `- Decade: ${decade}\n` +
    `- Budget: ${budgetRanges[budget]}\n\n` +
    `Reply with a JSON object containing:\n{\n  "title": string,\n  "year": string,\n  "country": string,\n  "director": string,\n  "description": string,\n  "watch_info": string\n}\n\nReturn only valid JSON.`;

  try {
    let movieInfo;
    while (true) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 350,
        temperature: 0.7
      });
      try {
        movieInfo = JSON.parse(completion.choices[0].message.content.trim());
      } catch {
        continue;
      }
      if (regionCountries[region].some(c => movieInfo.country.includes(c))) break;
    }

    if (process.env.OMDB_API_KEY) {
      try {
        const omdbRes = await fetch(
          `http://www.omdbapi.com/?t=${encodeURIComponent(movieInfo.title)}&apikey=${process.env.OMDB_API_KEY}`
        );
        const omdbData = await omdbRes.json();
        if (omdbData.Poster && omdbData.Poster !== 'N/A') {
          movieInfo.poster_url = omdbData.Poster;
        }
      } catch {}
    }
    movieInfo.poster_url = movieInfo.poster_url || '';

    // Attach metadata
    movieInfo.region = region;
    movieInfo.genre = genre;
    movieInfo.decade = decade;
    movieInfo.budget = budget;

    // Ensure compatibility
    movieInfo.release_year = movieInfo.year;
    res.json(movieInfo);

    const ua = req.headers['user-agent'] || '';
    if (!ua.includes('Headless')) {
      (async () => {
        const videoPath = path.join(__dirname, 'reveal.mp4');
        try {
          await recordSpinVideo(req.body, videoPath);
          await sendVideoEmail(videoPath, movieInfo);
        } catch {}
      })();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate movie' });
  }
});

// Receive and dispatch results (screenshots + poster)
app.post('/api/send-results', async (req, res) => {
  const { contacts, image, posterUrl } = req.body;
  const buffer = Buffer.from(image.split(',')[1], 'base64');
  const results = [];

  for (const contact of contacts) {
    try {
      if (/@/.test(contact)) {
        await emailTransporter.sendMail({
          from: process.env.SMTP_USER,
          to: contact,
          subject: 'Puddy Pictures Result',
          text: 'Here is the movie pick result!',
          attachments: [{ filename: 'result.png', content: buffer }]
        });
        results.push({ contact, status: 'email sent' });
      } else {
        const msgOptions = {
          to: contact,
          from: twilioFrom,
          body: 'Check out our movie pick:'
        };
        if (posterUrl && posterUrl.startsWith('https://')) {
          msgOptions.mediaUrl = [posterUrl];
        }
        await twilioClient.messages.create(msgOptions);
        results.push({ contact, status: 'sms sent' });
      }
    } catch (err) {
      console.error(`Error sending to ${contact}:`, err);
      results.push({ contact, status: 'error', error: err.message });
    }
  }

  // Respond with dispatch results
  return res.json({ results });
});

// 404 fallback
app.use((_, res) => res.status(404).send('Not Found'));

// Start server
app.listen(port, () => console.log(`Server listening at http://localhost:${port}`));
