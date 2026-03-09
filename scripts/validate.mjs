import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('/Users/gdragon/.openclaw/workspace/chuahpstix-league-viz');

async function main() {
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const data = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'chuah-data.json'), 'utf8'));

  if (!html.includes('data/chuah-data.json')) {
    throw new Error('index.html does not reference data/chuah-data.json');
  }

  if (!data.league?.matches?.length) {
    throw new Error('league data missing');
  }

  if (!data.tft?.matches?.length) {
    throw new Error('tft data missing');
  }

  console.log('validation ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
