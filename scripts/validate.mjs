import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('/Users/gdragon/.openclaw/workspace/chuahpstix-league-viz');

async function main() {
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const data = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'chuah-data.json'), 'utf8'));

  if (!html.includes('data/chuah-data.json')) {
    throw new Error('index.html does not reference data/chuah-data.json');
  }

  for (const required of [
    'champion identity tracker',
    'signature play',
    'playtime personality',
    'worst enemy',
    'personal records'
  ]) {
    if (!html.toLowerCase().includes(required)) {
      throw new Error(`index.html missing required section text: ${required}`);
    }
  }

  for (const forbidden of ['Snorlax', 'recent league shape', 'assets/snorlax.png']) {
    if (html.includes(forbidden)) {
      throw new Error(`index.html still contains removed content: ${forbidden}`);
    }
  }

  if (!data.league?.matches?.length) throw new Error('league recent match data missing');
  if ((data.league?.deepSampleSize || 0) < (data.league?.recentSampleSize || 0)) throw new Error('deep sample size is invalid');
  if (!data.league?.championIdentity?.truePool?.length) throw new Error('champion identity data missing');
  if (!data.league?.signaturePlay?.signals) throw new Error('signature play data missing');
  if (!data.league?.playtimePersonality?.bands?.length) throw new Error('playtime personality data missing');
  if (!data.league?.worstEnemy?.rows?.length) throw new Error('worst enemy data missing');
  if (!data.league?.records?.rows?.length) throw new Error('records data missing');
  if (!data.league?.topTeammates?.length) throw new Error('league teammate data missing');
  if (!data.tft?.matches?.length) throw new Error('tft data missing');

  console.log('validation ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
