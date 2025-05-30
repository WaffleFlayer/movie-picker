/*
Project Rules:
1. Do not change working code unless explicitly instructed.
2. Use modular design to isolate new features.
3. Save known-good checkpoints before making changes.
4. Provide diffs (only changed/added lines) when possible instead of full rewrites.
5. Help verify key features still work.
*/

require('dotenv').config();
const axios = require('axios');
const twilio = require('twilio');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// Base URL for your movie API (deployed on Railway)
const BASE_URL = process.env.MOVIE_API_URL || 'http://localhost:3000';

// Path to stored registrations (updated by /api/register-user)
const registrationsFile = path.join(__dirname, 'registrations.json');

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Load registered users
let registrations = [];
if (fs.existsSync(registrationsFile)) {
  registrations = JSON.parse(fs.readFileSync(registrationsFile, 'utf-8'));
  if (!registrations.length) {
    console.error('Registrations file is empty. No SMS will be sent.');
    process.exit(1);
  }
} else {
  console.error('No registrations file found!');
  process.exit(1);
}

// Call deployed server to generate a movie pick
async function generateMovie() {
  try {
    const response = await axios.post(
      `${BASE_URL}/api/generate-movie`,
      {} // empty body triggers random fallback
    );
    return response.data;
  } catch (error) {
    console.error(
      'Error generating movie:',
      error.response ? error.response.data : error.message
    );
    process.exit(1);
  }
}

// Generate a short, AI-powered intro for the SMS
async function generateIntroAI(movie) {
  const prompt = `Create a short, engaging intro for a movie night SMS. Use a friendly tone and highlight genre, region, and vibe. Here are the details:
Title: ${movie.title}
Genre: ${movie.genre}
Region: ${movie.region}
Release Year: ${movie.release_year}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a witty and creative movie club announcer.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error(
      'Error generating AI intro:',
      error.response ? error.response.data : error.message
    );
    process.exit(1);
  }
}

// Main: send weekly SMS to all registrations
async function sendWeeklySMS() {
  const movie = await generateMovie();
  const intro = await generateIntroAI(movie);

  for (const user of registrations) {
    const body = `${intro}\nWatch: ${movie.watch_info}`;
    const msgOptions = {
      from: twilioFrom,
      to: user.phone,
      body: body
    };

    // Attach poster if available
    if (movie.poster_url && movie.poster_url.startsWith('https://')) {
      msgOptions.mediaUrl = [movie.poster_url];
    }

    try {
      await twilioClient.messages.create(msgOptions);
      console.log(`✅ Sent to ${user.name} (${user.phone})`);
    } catch (err) {
      console.error(`❌ Error sending to ${user.phone}:`, err.message);
    }
  }

  console.log('🎉 All weekly picks sent!');
}

sendWeeklySMS();
