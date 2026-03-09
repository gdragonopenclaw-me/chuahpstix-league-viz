import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('/Users/gdragon/.openclaw/workspace/chuahpstix-league-viz');

async function main() {
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const quizHtml = await fs.readFile(path.join(ROOT, 'quiz.html'), 'utf8');
  const data = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'chuah-data.json'), 'utf8'));

  if (!html.includes('data/chuah-data.json')) throw new Error('index.html does not reference data/chuah-data.json');
  if (!quizHtml.includes('data/chuah-data.json')) throw new Error('quiz.html does not reference data/chuah-data.json');
  if (!html.includes('quiz.html')) throw new Error('index.html missing quiz link');

  for (const required of [
    'champion identity tracker',
    'signature play',
    'playtime personality',
    'worst enemy',
    'personal records',
    'spider/radar chart',
    'premade synergy vs solo-ish performance',
    'comfort level vs success level by class/subclass',
    'network graph'
  ]) {
    if (!html.toLowerCase().includes(required)) throw new Error(`index.html missing required section text: ${required}`);
  }

  for (const forbidden of ['tft still lives here too', 'tft recent board read', 'tactics.tools', 'data.tft']) {
    if (html.toLowerCase().includes(forbidden.toLowerCase())) throw new Error(`index.html still contains removed content: ${forbidden}`);
  }

  for (const required of [
    'how well do you know',
    'start quiz',
    'friend test mode',
    'answer review'
  ]) {
    if (!quizHtml.toLowerCase().includes(required)) throw new Error(`quiz.html missing required section text: ${required}`);
  }

  if (!data.players || typeof data.players !== 'object') throw new Error('multi-player payload missing');
  if (!Array.isArray(data.dynamicTargets) || data.dynamicTargets.length < 2) throw new Error('dynamic target allowlist missing');
  if (!data.defaultPlayerKey || !data.players[data.defaultPlayerKey]) throw new Error('default player missing from payload');

  for (const [key, league] of Object.entries(data.players)) {
    if (!league.profile?.riotId) throw new Error(`player ${key} missing profile`);
    if (!league.matches?.length) throw new Error(`player ${key} missing recent matches`);
    if ((league.deepSampleSize || 0) < (league.recentSampleSize || 0)) throw new Error(`player ${key} deep sample size invalid`);
    if (!league.championIdentity?.truePool?.length) throw new Error(`player ${key} champion identity data missing`);
    if (!league.championIdentity?.classRows?.length) throw new Error(`player ${key} class tag data missing`);
    if (!league.signaturePlay?.signals) throw new Error(`player ${key} signature play data missing`);
    if (!league.signaturePlay?.radar?.axes?.length) throw new Error(`player ${key} radar data missing`);
    if (!league.playtimePersonality?.bands?.length) throw new Error(`player ${key} playtime personality data missing`);
    if (!league.worstEnemy?.rows?.length) throw new Error(`player ${key} worst enemy data missing`);
    if (!league.records?.rows?.length) throw new Error(`player ${key} records data missing`);
    if (!league.topTeammates?.length) throw new Error(`player ${key} teammate data missing`);
    if (!league.premadeSynergy?.rows?.length) throw new Error(`player ${key} premade synergy data missing`);
    if (!league.network?.nodes?.length || !league.network?.edges?.length) throw new Error(`player ${key} network data missing`);
    if ((league.queueMix?.length || 0) < 1) throw new Error(`player ${key} queue mix too small`);
    if ((league.records?.rows?.length || 0) < 4) throw new Error(`player ${key} record rows too small for quiz`);
  }

  console.log('validation ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
