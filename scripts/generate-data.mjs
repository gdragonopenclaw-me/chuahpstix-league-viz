import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('/Users/gdragon/.openclaw/workspace/chuahpstix-league-viz');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'out');
const RIOT_KEY_PATH = path.join(process.env.HOME || '', '.openclaw', 'secrets', 'riot_api_key');

const LEAGUE_ACCOUNT = { gameName: 'chuahpstix', tagLine: 'NA1' };
const LEAGUE_COUNT = 10;
const TFT_TARGET_COUNT = 30;
const TACTICS_TOOLS_URL = 'https://tactics.tools/player/na/chuahpstix/NA1';

const queueLabels = {
  400: 'Normal Draft',
  420: 'Ranked Solo',
  430: 'Normal Blind',
  440: 'Ranked Flex',
  450: 'ARAM',
  490: 'Quickplay',
  700: 'Clash',
  1700: 'Arena',
  1160: 'Double Up'
};

function fmtPct(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function topEntries(counter, top = 5) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([name, count]) => ({ name, count }));
}

function winLossText(wins, total) {
  return `${wins}-${total - wins}`;
}

function championSlug(id) {
  return id.replace(/^TFT\d+_/, '').replace(/^TFTSet\d+_/, '');
}

function readableChampion(id) {
  const slug = championSlug(id);
  return slug
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([0-9]+)/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function kdaLine(match) {
  return `${match.kills}/${match.deaths}/${match.assists}`;
}

function queueName(queueId) {
  return queueLabels[queueId] || `Queue ${queueId}`;
}

async function riotGet(url, key) {
  const response = await fetch(url, {
    headers: {
      'X-Riot-Token': key,
      'User-Agent': 'Mozilla/5.0 OpenClaw/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Riot API ${response.status} for ${url}: ${await response.text()}`);
  }

  return response.json();
}

async function fetchLeague(key) {
  const account = await riotGet(
    `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(LEAGUE_ACCOUNT.gameName)}/${encodeURIComponent(LEAGUE_ACCOUNT.tagLine)}`,
    key
  );

  const matchIds = await riotGet(
    `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=${LEAGUE_COUNT}`,
    key
  );

  const matches = [];

  for (const matchId of matchIds) {
    const match = await riotGet(`https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`, key);
    const me = match.info.participants.find((participant) => participant.puuid === account.puuid);
    if (!me) continue;

    const team = match.info.participants.filter((participant) => participant.teamId === me.teamId);
    const teamKills = Math.max(1, team.reduce((sum, participant) => sum + participant.kills, 0));
    const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
    const kp = (me.kills + me.assists) / teamKills;

    matches.push({
      id: matchId,
      champion: me.championName,
      queueId: match.info.queueId,
      queueName: queueName(match.info.queueId),
      win: Boolean(me.win),
      kills: me.kills,
      deaths: me.deaths,
      assists: me.assists,
      kdaRatio: (me.kills + me.assists) / Math.max(1, me.deaths),
      cs,
      kp,
      damage: me.totalDamageDealtToChampions,
      gold: me.goldEarned,
      durationSeconds: match.info.gameDuration,
      endedAt: match.info.gameEndTimestamp,
      modeTag: match.info.queueId === 450 ? 'aram' : 'rift'
    });
  }

  const wins = matches.filter((match) => match.win).length;
  const championCounter = new Map();
  const queueCounter = new Map();
  for (const match of matches) {
    championCounter.set(match.champion, (championCounter.get(match.champion) || 0) + 1);
    queueCounter.set(match.queueName, (queueCounter.get(match.queueName) || 0) + 1);
  }

  const avgKda = avg(matches.map((match) => match.kdaRatio));
  const avgCs = avg(matches.map((match) => match.cs));
  const avgKp = avg(matches.map((match) => match.kp));

  let read = 'recent slate is mostly ARAM, so the profile reads less like lane-form scouting and more like teamfight throughput.';
  if (avgKp >= 0.7) read = 'recent games skew heavily toward teamfight involvement. lots of shared kill participation, more brawl anchor than split map grinder.';
  if (avgKda >= 3.5 && avgKp >= 0.7) read = 'the last 10 look like classic high-participation ARAM carry energy: strong fight uptime, solid cleanup, and repeated impact without needing perfect efficiency.';

  return {
    account,
    sampleSize: matches.length,
    wins,
    losses: matches.length - wins,
    record: winLossText(wins, matches.length),
    winRate: wins / Math.max(1, matches.length),
    avgKdaRatio: avgKda,
    avgCs,
    avgKp,
    topChampions: topEntries(championCounter, 4),
    queueMix: topEntries(queueCounter, 4),
    read,
    matches: matches.map((match) => ({
      ...match,
      kpPct: fmtPct(match.kp),
      kdaText: kdaLine(match)
    }))
  };
}

function deriveTftComp(units) {
  const sorted = [...units]
    .sort((a, b) => (b.rarity || 0) - (a.rarity || 0) || (b.tier || 0) - (a.tier || 0) || a.id.localeCompare(b.id))
    .slice(0, 4)
    .map((unit) => readableChampion(unit.id));
  return sorted.join(' / ');
}

function deriveTftArchetypes(matches) {
  const comboCounter = new Map();

  for (const match of matches) {
    const names = [...new Set((match.info.units || [])
      .filter((unit) => (unit.rarity || 0) >= 4)
      .map((unit) => readableChampion(unit.id)))].sort();

    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        for (let k = j + 1; k < names.length; k += 1) {
          const key = [names[i], names[j], names[k]].join(' / ');
          comboCounter.set(key, (comboCounter.get(key) || 0) + 1);
        }
      }
    }
  }

  return topEntries(comboCounter, 4);
}

function derivePlaystyle(matches) {
  const avgLevel = avg(matches.map((match) => match.info.level || 0));
  const avgLastRound = avg(matches.map((match) => match.info.lastRound || 0));
  const avgDamage = avg(matches.map((match) => match.info.totalDamageToPlayers || 0));
  const avgFlex = avg(matches.map((match) => match.ratings?.econ2 || 0));
  const avgExecution = avg(matches.map((match) => match.ratings?.meta2 || 0));

  const parts = [];
  if (avgLevel >= 8.5) parts.push('usually caps boards pretty high');
  if (avgLastRound >= 33) parts.push('tends to survive deep into lobbies');
  if (avgDamage >= 80) parts.push('converts strong boards into real player damage');
  if (avgFlex >= 0.5) parts.push('leans flexible on econ and pivots');
  if (avgExecution >= 0.5) parts.push('board quality looks deliberate rather than random-highroll');

  if (!parts.length) return 'mostly a results-first double up profile, with limited public telemetry beyond placements and boards.';
  return `${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)}, and ${parts.slice(1).join(', ')}.`;
}

async function fetchTft() {
  const response = await fetch(TACTICS_TOOLS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 OpenClaw/1.0' }
  });

  if (!response.ok) {
    throw new Error(`Tactics.tools ${response.status}: ${await response.text()}`);
  }

  const html = await response.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!nextDataMatch) {
    throw new Error('Could not locate __NEXT_DATA__ in tactics.tools response');
  }

  const page = JSON.parse(nextDataMatch[1]).props.pageProps;
  const matches = page.initialData.matches || [];
  const considered = matches.slice(0, TFT_TARGET_COUNT);
  const unitCounter = new Map();
  const queueCounter = new Map();

  for (const match of considered) {
    queueCounter.set(queueName(match.queueId), (queueCounter.get(queueName(match.queueId)) || 0) + 1);

    for (const unit of match.info.units || []) {
      const name = readableChampion(unit.id);
      unitCounter.set(name, (unitCounter.get(name) || 0) + 1);
    }
  }

  const avgPlacement = page.initialData.seasonStats?.avgPlace ?? avg(considered.map((match) => match.info.placement || 0));
  const top4Rate = (page.initialData.seasonStats?.top4 || 0) / Math.max(1, considered.length);
  const winRate = (page.initialData.seasonStats?.win || 0) / Math.max(1, considered.length);

  return {
    source: 'tactics.tools public profile page',
    requestedSampleSize: TFT_TARGET_COUNT,
    availableSampleSize: considered.length,
    avgPlacement,
    top4Rate,
    winRate,
    mostFrequentQueue: topEntries(queueCounter, 1)[0] || null,
    topChampions: topEntries(unitCounter, 6),
    topComps: deriveTftArchetypes(considered),
    playstyleRead: derivePlaystyle(considered),
    queueSeasonStats: page.initialData.queueSeasonStats,
    seasonStats: page.initialData.seasonStats,
    matches: considered.map((match) => ({
      id: match.id,
      dateTime: match.dateTime,
      queueId: match.queueId,
      queueName: queueName(match.queueId),
      placement: match.info.placement,
      level: match.info.level,
      lastRound: match.info.lastRound,
      totalDamageToPlayers: match.info.totalDamageToPlayers,
      lpDiff: match.lpDiff,
      rankBefore: match.rankBefore,
      rankAfter: match.rankAfter,
      comp: deriveTftComp(match.info.units || []),
      units: (match.info.units || []).map((unit) => ({
        name: readableChampion(unit.id),
        starLevel: unit.tier,
        rarity: unit.rarity,
        items: unit.items2 || []
      })),
      ratings: match.ratings || null
    }))
  };
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const riotKey = (await fs.readFile(RIOT_KEY_PATH, 'utf8')).trim();
  const [league, tft] = await Promise.all([fetchLeague(riotKey), fetchTft()]);

  const payload = {
    generatedAt: new Date().toISOString(),
    profile: {
      displayName: 'chuahpstix',
      tagline: 'NA1'
    },
    league,
    tft
  };

  const summary = {
    generatedAt: payload.generatedAt,
    league: {
      sampleSize: league.sampleSize,
      record: league.record,
      winRate: fmtPct(league.winRate),
      avgKdaRatio: Number(league.avgKdaRatio.toFixed(2)),
      avgCs: Number(league.avgCs.toFixed(1)),
      avgKp: fmtPct(league.avgKp),
      topChampions: league.topChampions,
      queueMix: league.queueMix
    },
    tft: {
      requestedSampleSize: tft.requestedSampleSize,
      availableSampleSize: tft.availableSampleSize,
      avgPlacement: Number(tft.avgPlacement.toFixed(2)),
      top4Rate: fmtPct(tft.top4Rate),
      winRate: fmtPct(tft.winRate),
      mostFrequentQueue: tft.mostFrequentQueue,
      topChampions: tft.topChampions,
      topComps: tft.topComps,
      playstyleRead: tft.playstyleRead
    }
  };

  await fs.writeFile(path.join(DATA_DIR, 'chuah-data.json'), JSON.stringify(payload, null, 2));
  await fs.writeFile(path.join(OUT_DIR, 'chuah-summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(OUT_DIR, 'chuah-summary.md'), [
    `# Chuah app data refresh`,
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    `## League last 10`,
    `- Record: ${summary.league.record} (${summary.league.winRate})`,
    `- Avg KDA ratio: ${summary.league.avgKdaRatio}`,
    `- Avg CS: ${summary.league.avgCs}`,
    `- Avg KP: ${summary.league.avgKp}`,
    '',
    `## TFT public sample`,
    `- Requested: ${summary.tft.requestedSampleSize}`,
    `- Available from source: ${summary.tft.availableSampleSize}`,
    `- Avg placement: ${summary.tft.avgPlacement}`,
    `- Top 4 rate: ${summary.tft.top4Rate}`,
    `- Win rate: ${summary.tft.winRate}`,
    `- Queue: ${summary.tft.mostFrequentQueue ? `${summary.tft.mostFrequentQueue.name} (${summary.tft.mostFrequentQueue.count})` : 'n/a'}`,
    `- Read: ${summary.tft.playstyleRead}`,
    ''
  ].join('\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
