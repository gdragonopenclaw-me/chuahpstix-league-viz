import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('/Users/gdragon/.openclaw/workspace/chuahpstix-league-viz');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'out');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const RIOT_KEY_PATH = path.join(process.env.HOME || '', '.openclaw', 'secrets', 'riot_api_key');

const ROOT_PLAYERS = ['chuahpstix#NA1', 'lintaho#NA1'];
const RECENT_MATCH_COUNT = 10;
const HISTORY_TARGET_ROOT = 220;
const HISTORY_TARGET_ALLOWED = 140;
const HISTORY_PAGE = 100;
const TEAMMATE_TOP = 10;
const DYNAMIC_TOP = 5;
const LOCAL_TIMEZONE = 'America/New_York';
const DATA_VERSION = 2;

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

function num(value, digits = 1) {
  return Number((value || 0).toFixed(digits));
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function safeDiv(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function topEntries(counter, top = 5) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, top)
    .map(([name, count]) => ({ name, count }));
}

function winLossText(wins, total) {
  return `${wins}-${Math.max(0, total - wins)}`;
}

function queueName(queueId) {
  return queueLabels[queueId] || `Queue ${queueId}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function canonicalRiotId(value) {
  return String(value || '').trim().toLowerCase();
}

function parseRiotId(value) {
  const raw = String(value || '').trim();
  const hash = raw.lastIndexOf('#');
  if (hash <= 0) throw new Error(`Invalid Riot ID: ${value}`);
  return { gameName: raw.slice(0, hash), tagLine: raw.slice(hash + 1) };
}

function makeRiotId(gameName, tagLine) {
  return `${gameName}#${tagLine}`;
}

function cachePath(...parts) {
  return path.join(CACHE_DIR, ...parts);
}

function sanitizeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

async function cacheJson(file, producer) {
  const cached = await readJsonIfExists(file);
  if (cached !== null) return cached;
  const fresh = await producer();
  await writeJson(file, fresh);
  return fresh;
}

async function riotGet(url, key, attempt = 0) {
  const response = await fetch(url, {
    headers: {
      'X-Riot-Token': key,
      'User-Agent': 'Mozilla/5.0 OpenClaw/1.0'
    }
  });

  if (response.status === 429 && attempt < 6) {
    const retryAfterSeconds = Number(response.headers.get('retry-after') || '1');
    await sleep(Math.max(1, retryAfterSeconds) * 1000);
    return riotGet(url, key, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Riot API ${response.status} for ${url}: ${await response.text()}`);
  }

  return response.json();
}

async function fetchChampionData() {
  return cacheJson(cachePath('ddragon', 'champions.json'), async () => {
    const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json', {
      headers: { 'User-Agent': 'Mozilla/5.0 OpenClaw/1.0' }
    }).then((response) => response.json());
    const version = versions[0];
    const payload = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 OpenClaw/1.0' }
    }).then((response) => response.json());

    const champions = Object.values(payload.data).map((champion) => ({
      id: champion.id,
      key: Number(champion.key),
      name: champion.name,
      title: champion.title,
      tags: champion.tags || [],
      partype: champion.partype || null,
      info: champion.info || {}
    }));

    return { version, champions };
  });
}

function buildChampionLookup(championData) {
  const byId = new Map();
  const byName = new Map();
  for (const champion of championData.champions) {
    byId.set(champion.key, champion);
    byName.set(champion.name, champion);
  }
  return { byId, byName, version: championData.version };
}

function deriveSubclass(tags) {
  if (tags[1]) return tags[1];
  const primary = tags[0] || 'Unknown';
  const fallback = {
    Assassin: 'Burst',
    Fighter: 'Skirmish',
    Mage: 'Spellcast',
    Marksman: 'Carry',
    Support: 'Utility',
    Tank: 'Frontline'
  };
  return fallback[primary] || 'Generalist';
}

function championTagProfile(championLookup, championName) {
  const champion = championLookup.byName.get(championName);
  const tags = champion?.tags?.length ? champion.tags : ['Unknown'];
  const primary = tags[0] || 'Unknown';
  const subclass = deriveSubclass(tags);
  return {
    tags,
    primaryClass: primary,
    subclass,
    classProfile: `${primary} / ${subclass}`
  };
}

function participantDisplayName(participant) {
  if (participant.riotIdGameName && participant.riotIdTagline) {
    return `${participant.riotIdGameName}#${participant.riotIdTagline}`;
  }
  return participant.summonerName || 'Unknown teammate';
}

function getChallenges(participant) {
  return participant.challenges || {};
}

function percentileRank(values, value) {
  if (!values.length) return null;
  const lower = values.filter((entry) => entry < value).length;
  const equal = values.filter((entry) => entry === value).length;
  return (lower + Math.max(0, equal - 1) / 2) / Math.max(1, values.length - 1);
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function hourOfDay(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TIMEZONE,
    hour: '2-digit',
    hour12: false
  }).formatToParts(new Date(timestamp));
  return Number(parts.find((part) => part.type === 'hour')?.value || '0');
}

function timeBandLabel(hour) {
  if (hour >= 0 && hour < 6) return 'Late night (12a-6a)';
  if (hour < 12) return 'Morning (6a-12p)';
  if (hour < 18) return 'Afternoon (12p-6p)';
  return 'Evening (6p-12a)';
}

function recordSummary(matches) {
  const wins = matches.filter((match) => match.win).length;
  return {
    games: matches.length,
    wins,
    losses: matches.length - wins,
    record: winLossText(wins, matches.length),
    winRate: wins / Math.max(1, matches.length)
  };
}

async function fetchAccountByRiotId(riotId, key) {
  const { gameName, tagLine } = parseRiotId(riotId);
  const file = cachePath('riot', 'accounts', `${sanitizeFilePart(canonicalRiotId(riotId))}.json`);
  return cacheJson(file, () => riotGet(
    `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    key
  ));
}

async function fetchSummonerByPuuid(puuid, key) {
  const file = cachePath('riot', 'summoners', `${sanitizeFilePart(puuid)}.json`);
  return cacheJson(file, () => riotGet(`https://na1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`, key));
}

async function fetchMasteryByPuuid(puuid, key) {
  const file = cachePath('riot', 'mastery', `${sanitizeFilePart(puuid)}.json`);
  return cacheJson(file, () => riotGet(`https://na1.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`, key));
}

async function fetchMatchIds(puuid, targetCount, key) {
  const file = cachePath('riot', 'match-ids', `${sanitizeFilePart(puuid)}-${targetCount}.json`);
  return cacheJson(file, async () => {
    const matchIds = [];
    for (let start = 0; start < targetCount; start += HISTORY_PAGE) {
      const batch = await riotGet(
        `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${Math.min(HISTORY_PAGE, targetCount - start)}`,
        key
      );
      matchIds.push(...batch);
      if (batch.length < HISTORY_PAGE) break;
      await sleep(1200);
    }
    return matchIds;
  });
}

async function fetchMatch(matchId, key) {
  const file = cachePath('riot', 'matches', `${sanitizeFilePart(matchId)}.json`);
  return cacheJson(file, async () => {
    const payload = await riotGet(`https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`, key);
    await sleep(90);
    return payload;
  });
}

async function fetchPlayerBundle(riotId, targetCount, key) {
  const account = await fetchAccountByRiotId(riotId, key);
  const [summoner, masteryRaw, matchIds] = await Promise.all([
    fetchSummonerByPuuid(account.puuid, key),
    fetchMasteryByPuuid(account.puuid, key),
    fetchMatchIds(account.puuid, targetCount, key)
  ]);

  const rawMatches = [];
  for (const matchId of matchIds) {
    try {
      const match = await fetchMatch(matchId, key);
      rawMatches.push(match);
    } catch (error) {
      console.error(`Skipping ${matchId} for ${riotId}: ${error.message}`);
    }
  }

  return { account, summoner, masteryRaw, rawMatches };
}

function summarizePlayer({ riotId, account, summoner, masteryRaw, rawMatches, championLookup, allowedPlayerMap }) {
  const masteryByName = new Map(
    masteryRaw.map((entry) => {
      const champion = championLookup.byId.get(entry.championId)?.name || `Champion ${entry.championId}`;
      return [champion, {
        championId: entry.championId,
        championLevel: entry.championLevel,
        championPoints: entry.championPoints,
        lastPlayTime: entry.lastPlayTime
      }];
    })
  );

  const matches = [];
  const teammateCounter = new Map();
  const roleCounter = new Map();

  for (const [index, raw] of rawMatches.entries()) {
    if (!raw?.info?.participants?.length) continue;
    const me = raw.info.participants.find((participant) => participant.puuid === account.puuid);
    if (!me) continue;

    const team = raw.info.participants.filter((participant) => participant.teamId === me.teamId);
    const enemies = raw.info.participants.filter((participant) => participant.teamId !== me.teamId);
    const teammates = team.filter((participant) => participant.puuid !== me.puuid);

    for (const teammate of teammates) {
      const name = participantDisplayName(teammate);
      const row = teammateCounter.get(name) || { name, games: 0, wins: 0, losses: 0 };
      row.games += 1;
      if (me.win) row.wins += 1;
      else row.losses += 1;
      teammateCounter.set(name, row);
    }

    const challenges = getChallenges(me);
    const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
    const teamKills = Math.max(1, team.reduce((sum, participant) => sum + participant.kills, 0));
    const durationMinutes = Math.max(1, raw.info.gameDuration / 60);
    const timestamp = raw.info.gameEndTimestamp || raw.info.gameCreation;
    const hour = hourOfDay(timestamp);
    const enemyChampion = enemies.find((participant) => participant.teamPosition && participant.teamPosition === me.teamPosition)?.championName
      || enemies.reduce((best, participant) => (participant.totalDamageDealtToChampions || 0) > (best.totalDamageDealtToChampions || 0) ? participant : best, enemies[0])?.championName
      || enemies[0]?.championName
      || 'Unknown';

    const metricValues = {
      kp: raw.info.participants.map((participant) => getChallenges(participant).killParticipation).filter((value) => Number.isFinite(value)),
      dpm: raw.info.participants.map((participant) => getChallenges(participant).damagePerMinute).filter((value) => Number.isFinite(value)),
      teamDamage: raw.info.participants.map((participant) => getChallenges(participant).teamDamagePercentage).filter((value) => Number.isFinite(value)),
      early: raw.info.participants.map((participant) => getChallenges(participant).takedownsFirstXMinutes).filter((value) => Number.isFinite(value)),
      vision: raw.info.participants.map((participant) => getChallenges(participant).visionScorePerMinute).filter((value) => Number.isFinite(value)),
      cc: raw.info.participants.map((participant) => getChallenges(participant).enemyChampionImmobilizations).filter((value) => Number.isFinite(value))
    };

    const participantRiotIds = team
      .filter((participant) => participant.riotIdGameName && participant.riotIdTagline)
      .map((participant) => makeRiotId(participant.riotIdGameName, participant.riotIdTagline));

    matches.push({
      id: raw.metadata?.matchId || `match-${index}`,
      champion: me.championName,
      championId: me.championId,
      queueId: raw.info.queueId,
      queueName: queueName(raw.info.queueId),
      modeTag: raw.info.queueId === 450 ? 'aram' : 'rift',
      win: Boolean(me.win),
      kills: me.kills,
      deaths: me.deaths,
      assists: me.assists,
      kdaRatio: safeDiv(me.kills + me.assists, Math.max(1, me.deaths)),
      kdaText: `${me.kills}/${me.deaths}/${me.assists}`,
      cs,
      damage: me.totalDamageDealtToChampions,
      damageTaken: me.totalDamageTaken,
      damageMitigated: me.damageSelfMitigated,
      gold: me.goldEarned,
      visionScore: me.visionScore,
      durationMinutes,
      endedAt: timestamp,
      endedAtText: formatDateTime(timestamp),
      hour,
      timeBand: timeBandLabel(hour),
      role: me.teamPosition || me.individualPosition || 'Unknown',
      teamKills,
      teamRiotIds: participantRiotIds,
      teamDamageShare: challenges.teamDamagePercentage ?? safeDiv(me.totalDamageDealtToChampions, Math.max(1, team.reduce((sum, participant) => sum + participant.totalDamageDealtToChampions, 0))),
      kp: challenges.killParticipation ?? safeDiv(me.kills + me.assists, teamKills),
      dpm: challenges.damagePerMinute ?? safeDiv(me.totalDamageDealtToChampions, durationMinutes),
      visionPerMinute: challenges.visionScorePerMinute ?? safeDiv(me.visionScore, durationMinutes),
      earlyTakedowns: challenges.takedownsFirstXMinutes ?? null,
      ccScore: challenges.enemyChampionImmobilizations ?? null,
      soloKills: challenges.soloKills ?? 0,
      objectiveSteals: me.objectivesStolen ?? 0,
      epicMonsterSteals: challenges.epicMonsterSteals ?? 0,
      enemyChampion,
      percentiles: {
        kp: percentileRank(metricValues.kp, challenges.killParticipation ?? safeDiv(me.kills + me.assists, teamKills)),
        dpm: percentileRank(metricValues.dpm, challenges.damagePerMinute ?? safeDiv(me.totalDamageDealtToChampions, durationMinutes)),
        teamDamage: percentileRank(metricValues.teamDamage, challenges.teamDamagePercentage ?? 0),
        early: percentileRank(metricValues.early, challenges.takedownsFirstXMinutes ?? 0),
        vision: percentileRank(metricValues.vision, challenges.visionScorePerMinute ?? safeDiv(me.visionScore, durationMinutes)),
        cc: percentileRank(metricValues.cc, challenges.enemyChampionImmobilizations ?? 0)
      }
    });

    roleCounter.set(me.teamPosition || me.individualPosition || 'Unknown', (roleCounter.get(me.teamPosition || me.individualPosition || 'Unknown') || 0) + 1);
  }

  const recentMatches = matches.slice(0, RECENT_MATCH_COUNT);
  const overall = recordSummary(matches);
  const recent = recordSummary(recentMatches);
  const queueCounter = new Map();
  const championCounter = new Map();
  const championRows = new Map();
  const worstEnemyMap = new Map();
  const timeBandMap = new Map();

  for (const match of matches) {
    queueCounter.set(match.queueName, (queueCounter.get(match.queueName) || 0) + 1);
    championCounter.set(match.champion, (championCounter.get(match.champion) || 0) + 1);

    const championRow = championRows.get(match.champion) || {
      champion: match.champion,
      games: 0,
      wins: 0,
      kills: [],
      deaths: [],
      assists: [],
      kdaRatios: [],
      damage: [],
      cs: [],
      kp: [],
      lastPlayedAt: 0
    };
    championRow.games += 1;
    championRow.wins += match.win ? 1 : 0;
    championRow.kills.push(match.kills);
    championRow.deaths.push(match.deaths);
    championRow.assists.push(match.assists);
    championRow.kdaRatios.push(match.kdaRatio);
    championRow.damage.push(match.damage);
    championRow.cs.push(match.cs);
    championRow.kp.push(match.kp);
    championRow.lastPlayedAt = Math.max(championRow.lastPlayedAt, match.endedAt);
    championRows.set(match.champion, championRow);

    const worstEnemy = worstEnemyMap.get(match.enemyChampion) || {
      champion: match.enemyChampion,
      games: 0,
      wins: 0,
      losses: 0,
      deaths: [],
      kdaRatios: [],
      damage: []
    };
    worstEnemy.games += 1;
    worstEnemy.wins += match.win ? 1 : 0;
    worstEnemy.losses += match.win ? 0 : 1;
    worstEnemy.deaths.push(match.deaths);
    worstEnemy.kdaRatios.push(match.kdaRatio);
    worstEnemy.damage.push(match.damage);
    worstEnemyMap.set(match.enemyChampion, worstEnemy);

    const band = timeBandMap.get(match.timeBand) || { label: match.timeBand, matches: [] };
    band.matches.push(match);
    timeBandMap.set(match.timeBand, band);
  }

  for (const raw of masteryRaw) {
    const champion = championLookup.byId.get(raw.championId)?.name || `Champion ${raw.championId}`;
    if (!championRows.has(champion)) {
      championRows.set(champion, {
        champion,
        games: 0,
        wins: 0,
        kills: [],
        deaths: [],
        assists: [],
        kdaRatios: [],
        damage: [],
        cs: [],
        kp: [],
        lastPlayedAt: raw.lastPlayTime || 0
      });
    }
  }

  const masteryPoints = [...masteryByName.values()].map((entry) => entry.championPoints);
  const maxMastery = Math.max(...masteryPoints, 1);
  const maxGames = Math.max(...[...championRows.values()].map((entry) => entry.games), 1);

  const championIdentityRows = [...championRows.values()]
    .map((entry) => {
      const mastery = masteryByName.get(entry.champion) || null;
      const familiarityScore = (entry.games / maxGames) * 0.55 + ((mastery?.championPoints || 0) / maxMastery) * 0.45;
      const winRate = safeDiv(entry.wins, Math.max(1, entry.games));
      const classInfo = championTagProfile(championLookup, entry.champion);
      return {
        champion: entry.champion,
        games: entry.games,
        wins: entry.wins,
        losses: Math.max(0, entry.games - entry.wins),
        record: winLossText(entry.wins, entry.games),
        winRate,
        winRateText: fmtPct(winRate),
        avgKills: num(avg(entry.kills), 1),
        avgDeaths: num(avg(entry.deaths), 1),
        avgAssists: num(avg(entry.assists), 1),
        avgKda: num(avg(entry.kdaRatios), 2),
        avgDamage: num(avg(entry.damage), 0),
        avgCs: num(avg(entry.cs), 1),
        avgKp: avg(entry.kp),
        lastPlayedAt: entry.lastPlayedAt,
        lastPlayedAtText: entry.lastPlayedAt ? formatDateTime(entry.lastPlayedAt) : null,
        masteryLevel: mastery?.championLevel || 0,
        masteryPoints: mastery?.championPoints || 0,
        familiarityScore,
        poolWeight: num(familiarityScore * 100, 1),
        ...classInfo
      };
    })
    .sort((a, b) => b.familiarityScore - a.familiarityScore || b.games - a.games || a.champion.localeCompare(b.champion));

  const truePool = championIdentityRows.filter((entry) => entry.games > 0).slice(0, 8);
  const highFamiliarityPoorResults = championIdentityRows
    .filter((entry) => entry.games >= 2 && entry.masteryPoints > 0)
    .filter((entry) => entry.familiarityScore >= 0.35 && entry.winRate <= overall.winRate - 0.08)
    .sort((a, b) => (a.winRate - b.winRate) || (b.masteryPoints - a.masteryPoints))
    .slice(0, 4);
  const lowFamiliarityStrongResults = championIdentityRows
    .filter((entry) => entry.games >= 2)
    .filter((entry) => entry.familiarityScore <= 0.3 && entry.winRate >= overall.winRate + 0.1)
    .sort((a, b) => (b.winRate - a.winRate) || (a.masteryPoints - b.masteryPoints))
    .slice(0, 4);

  const groupByClassProfile = new Map();
  const groupByPrimaryClass = new Map();
  for (const row of championIdentityRows.filter((entry) => entry.games > 0)) {
    const classRow = groupByClassProfile.get(row.classProfile) || { label: row.classProfile, games: 0, wins: 0, familiaritySum: 0, champions: [] };
    classRow.games += row.games;
    classRow.wins += row.wins;
    classRow.familiaritySum += row.familiarityScore * row.games;
    classRow.champions.push(row.champion);
    groupByClassProfile.set(row.classProfile, classRow);

    const primaryRow = groupByPrimaryClass.get(row.primaryClass) || { label: row.primaryClass, games: 0, wins: 0, familiaritySum: 0, champions: [] };
    primaryRow.games += row.games;
    primaryRow.wins += row.wins;
    primaryRow.familiaritySum += row.familiarityScore * row.games;
    primaryRow.champions.push(row.champion);
    groupByPrimaryClass.set(row.primaryClass, primaryRow);
  }

  const classRows = [...groupByClassProfile.values()]
    .map((entry) => ({
      ...entry,
      winRate: safeDiv(entry.wins, entry.games),
      winRateText: fmtPct(safeDiv(entry.wins, entry.games)),
      avgFamiliarity: safeDiv(entry.familiaritySum, entry.games),
      comfortText: fmtPct(safeDiv(entry.familiaritySum, entry.games)),
      championList: entry.champions.sort().join(', ')
    }))
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate)
    .slice(0, 8);

  const primaryClassRows = [...groupByPrimaryClass.values()]
    .map((entry) => ({
      ...entry,
      winRate: safeDiv(entry.wins, entry.games),
      winRateText: fmtPct(safeDiv(entry.wins, entry.games)),
      avgFamiliarity: safeDiv(entry.familiaritySum, entry.games),
      comfortText: fmtPct(safeDiv(entry.familiaritySum, entry.games)),
      championList: entry.champions.sort().join(', ')
    }))
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate);

  const comfortLeader = [...classRows].filter((entry) => entry.games >= 4).sort((a, b) => b.avgFamiliarity - a.avgFamiliarity || b.games - a.games)[0] || null;
  const successLeader = [...classRows].filter((entry) => entry.games >= 4).sort((a, b) => b.winRate - a.winRate || b.games - a.games)[0] || null;
  let classRead = 'class-level reads are still thin, so this mostly works as descriptive context rather than hard truth.';
  if (comfortLeader && successLeader) {
    classRead = comfortLeader.label === successLeader.label
      ? `${comfortLeader.label} is both the comfort home and one of the cleaner result buckets in this sample.`
      : `${comfortLeader.label} looks like the comfort lane, while ${successLeader.label} has been converting the best results.`;
  }

  const signalDefs = [
    {
      key: 'early',
      label: 'early fight ignition',
      description: 'gets involved unusually early, with above-lobby takedown pace in the first chunk of the game.',
      valueFor: (match) => match.earlyTakedowns,
      format: (value) => `${num(value, 1)} early takedowns`
    },
    {
      key: 'kp',
      label: 'teamfight glue',
      description: 'shows up in a larger share of team kills than the average player in the same lobbies.',
      valueFor: (match) => match.kp,
      format: (value) => `${fmtPct(value)} kill participation`
    },
    {
      key: 'teamDamage',
      label: 'damage share gravity',
      description: 'soaks up a bigger slice of team damage responsibility than typical participants in the same matches.',
      valueFor: (match) => match.teamDamageShare,
      format: (value) => `${fmtPct(value)} team damage share`
    },
    {
      key: 'dpm',
      label: 'damage throughput',
      description: 'converts game time into champion damage better than the match median.',
      valueFor: (match) => match.dpm,
      format: (value) => `${num(value, 0)} damage/min`
    },
    {
      key: 'vision',
      label: 'vision control',
      description: 'creates more vision value per minute than the surrounding lobby.',
      valueFor: (match) => match.visionPerMinute,
      format: (value) => `${num(value, 2)} vision/min`
    },
    {
      key: 'cc',
      label: 'setup and crowd control',
      description: 'lands more immobilization-driven setup than the average participant.',
      valueFor: (match) => match.ccScore,
      format: (value) => `${num(value, 1)} immobilizations`
    }
  ];

  const signatureSignals = signalDefs
    .map((definition) => {
      const observations = matches
        .map((match) => ({ match, percentile: match.percentiles[definition.key], value: definition.valueFor(match) }))
        .filter((entry) => Number.isFinite(entry.percentile) && Number.isFinite(entry.value));
      const avgPercentile = avg(observations.map((entry) => entry.percentile));
      return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        sampleSize: observations.length,
        avgPercentile,
        avgPercentileText: fmtPct(avgPercentile),
        avgValue: avg(observations.map((entry) => entry.value)),
        avgValueText: definition.format(avg(observations.map((entry) => entry.value))),
        supportingGames: observations.filter((entry) => entry.percentile >= 0.7).length
      };
    })
    .filter((entry) => entry.sampleSize >= 8 && entry.avgPercentile >= 0.52 && entry.avgValue > 0)
    .sort((a, b) => b.avgPercentile - a.avgPercentile)
    .slice(0, 4);

  const objectiveStealTotal = matches.reduce((sum, match) => sum + match.epicMonsterSteals + match.objectiveSteals, 0);
  if (objectiveStealTotal > 0) {
    signatureSignals.push({
      key: 'steals',
      label: 'objective theft pressure',
      description: 'has actual steal events in the fetched sample, so the page can call it out without guessing.',
      sampleSize: matches.length,
      avgPercentile: 0.5,
      avgPercentileText: 'n/a',
      avgValue: objectiveStealTotal,
      avgValueText: `${objectiveStealTotal} total steals`,
      supportingGames: matches.filter((match) => match.epicMonsterSteals + match.objectiveSteals > 0).length
    });
  }

  const playtimeBands = [...timeBandMap.values()]
    .map((entry) => {
      const summary = recordSummary(entry.matches);
      return {
        label: entry.label,
        games: entry.matches.length,
        record: summary.record,
        winRate: summary.winRate,
        winRateText: fmtPct(summary.winRate),
        avgKda: num(avg(entry.matches.map((match) => match.kdaRatio)), 2),
        avgKp: fmtPct(avg(entry.matches.map((match) => match.kp))),
        avgDamage: num(avg(entry.matches.map((match) => match.damage)), 0),
        avgDeaths: num(avg(entry.matches.map((match) => match.deaths)), 1)
      };
    })
    .sort((a, b) => ['Late night (12a-6a)', 'Morning (6a-12p)', 'Afternoon (12p-6p)', 'Evening (6p-12a)'].indexOf(a.label) - ['Late night (12a-6a)', 'Morning (6a-12p)', 'Afternoon (12p-6p)', 'Evening (6p-12a)'].indexOf(b.label));

  const lateNight = playtimeBands.find((entry) => entry.label.startsWith('Late night'));
  const bestBand = [...playtimeBands].sort((a, b) => (b.winRate - a.winRate) || (b.avgKda - a.avgKda))[0] || null;
  const worstBand = [...playtimeBands].sort((a, b) => (a.winRate - b.winRate) || (a.avgKda - b.avgKda))[0] || null;
  let playtimeRead = 'time-of-day splits are pretty flat in this fetched window, so no strong personality claim yet.';
  if (lateNight && lateNight.games >= 6 && Math.abs(lateNight.winRate - overall.winRate) >= 0.1) {
    playtimeRead = lateNight.winRate > overall.winRate
      ? `late-night games actually run hotter than the overall baseline in this window: ${lateNight.record} with ${lateNight.winRateText}.`
      : `late-night queueing looks rougher than the overall baseline here: ${lateNight.record} with ${lateNight.winRateText}.`;
  } else if (bestBand && worstBand && bestBand.label !== worstBand.label && bestBand.games >= 5 && worstBand.games >= 5 && Math.abs(bestBand.winRate - worstBand.winRate) >= 0.12) {
    playtimeRead = `${bestBand.label} has been the cleanest performance band so far, while ${worstBand.label.toLowerCase()} has been the shakier one.`;
  }

  const worstEnemies = [...worstEnemyMap.values()]
    .map((entry) => ({
      champion: entry.champion,
      games: entry.games,
      losses: entry.losses,
      wins: entry.wins,
      lossRate: safeDiv(entry.losses, Math.max(1, entry.games)),
      lossRateText: fmtPct(safeDiv(entry.losses, Math.max(1, entry.games))),
      avgDeaths: num(avg(entry.deaths), 1),
      avgKda: num(avg(entry.kdaRatios), 2),
      avgDamage: num(avg(entry.damage), 0),
      caution: entry.games < 5 ? 'small sample, treat lightly' : 'enough repeat exposure to be worth noticing',
      score: safeDiv(entry.losses, Math.max(1, entry.games)) * Math.min(1, entry.games / 6) + safeDiv(avg(entry.deaths), 20) * 0.15
    }))
    .filter((entry) => entry.games >= 3)
    .sort((a, b) => b.score - a.score || b.games - a.games)
    .slice(0, 5);

  const recordDefs = [
    { key: 'kills', label: 'highest kills' },
    { key: 'assists', label: 'highest assists' },
    { key: 'deaths', label: 'most deaths' },
    { key: 'damage', label: 'highest damage' },
    { key: 'cs', label: 'highest CS' },
    { key: 'kp', label: 'highest kill participation' },
    { key: 'kdaRatio', label: 'best KDA' },
    { key: 'visionPerMinute', label: 'best vision/min' }
  ];

  const records = recordDefs.map((definition) => {
    const match = [...matches].sort((a, b) => b[definition.key] - a[definition.key])[0];
    const value = definition.key === 'kp'
      ? fmtPct(match.kp)
      : definition.key === 'kdaRatio'
        ? num(match.kdaRatio, 2)
        : definition.key === 'visionPerMinute'
          ? num(match.visionPerMinute, 2)
          : match[definition.key];
    return {
      label: definition.label,
      value,
      champion: match.champion,
      queueName: match.queueName,
      endedAtText: match.endedAtText,
      matchId: match.id,
      kdaText: match.kdaText
    };
  });

  const topTeammates = [...teammateCounter.values()]
    .sort((a, b) => b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name))
    .slice(0, TEAMMATE_TOP)
    .map((entry) => {
      const canonical = canonicalRiotId(entry.name);
      const switchTarget = allowedPlayerMap[canonical] || null;
      return {
        ...entry,
        record: `${entry.wins}-${entry.losses}`,
        winRate: entry.wins / Math.max(1, entry.games),
        winRateText: fmtPct(entry.wins / Math.max(1, entry.games), 0),
        canonical,
        switchable: Boolean(switchTarget),
        switchTargetKey: switchTarget?.key || null,
        switchTargetLabel: switchTarget?.riotId || null
      };
    });

  const topTeammateSet = new Set(topTeammates.map((entry) => canonicalRiotId(entry.name)));
  const synergyBuckets = new Map();
  for (let i = 0; i <= 4; i += 1) synergyBuckets.set(i, { count: i, games: 0, wins: 0 });
  for (const match of matches) {
    const partnerCount = match.teamRiotIds
      .filter((riotIdValue) => canonicalRiotId(riotIdValue) !== canonicalRiotId(riotId))
      .filter((riotIdValue) => topTeammateSet.has(canonicalRiotId(riotIdValue))).length;
    const bucket = synergyBuckets.get(Math.max(0, Math.min(4, partnerCount)));
    bucket.games += 1;
    bucket.wins += match.win ? 1 : 0;
  }
  const synergyRows = [...synergyBuckets.values()].map((entry) => ({
    ...entry,
    losses: entry.games - entry.wins,
    record: winLossText(entry.wins, entry.games),
    winRate: safeDiv(entry.wins, entry.games),
    winRateText: fmtPct(safeDiv(entry.wins, entry.games)),
    label: entry.count === 0 ? '0 top-10 friends' : `${entry.count} top-10 friend${entry.count === 1 ? '' : 's'}`
  }));
  const soloish = synergyRows.find((entry) => entry.count === 0);
  const stacked = synergyRows.filter((entry) => entry.count >= 2).reduce((acc, entry) => ({ games: acc.games + entry.games, wins: acc.wins + entry.wins }), { games: 0, wins: 0 });
  const stackedWinRate = safeDiv(stacked.wins, stacked.games);
  let synergyRead = 'the premade split is mostly descriptive here, not enough to call a giant performance gap.';
  if ((soloish?.games || 0) >= 5 && stacked.games >= 5 && Math.abs((soloish?.winRate || 0) - stackedWinRate) >= 0.08) {
    synergyRead = stackedWinRate > (soloish?.winRate || 0)
      ? `this sample runs cleaner with a real stack: ${fmtPct(stackedWinRate)} when 2+ top-10 friends show up, versus ${soloish?.winRateText || '0.0%'} in the solo-ish bucket.`
      : `the solo-ish bucket is weirdly steadier here: ${soloish?.winRateText || '0.0%'} without top-10 friends, versus ${fmtPct(stackedWinRate)} with 2+ of them around.`;
  }

  const radarDefs = [
    ['teamfight glue', 'kp'],
    ['damage share', 'teamDamage'],
    ['damage/min', 'dpm'],
    ['vision', 'vision'],
    ['setup cc', 'cc'],
    ['early fights', 'early']
  ];
  const radarAxes = radarDefs.map(([label, key]) => {
    const relevant = matches.map((match) => match.percentiles[key]).filter((value) => Number.isFinite(value));
    const value = avg(relevant);
    return {
      label,
      key,
      value,
      score: Math.round(value * 100)
    };
  });

  const networkNodeIds = [canonicalRiotId(riotId), ...topTeammates.map((entry) => canonicalRiotId(entry.name))];
  const networkNodeSet = new Set(networkNodeIds);
  const nodeMeta = new Map();
  nodeMeta.set(canonicalRiotId(riotId), { id: canonicalRiotId(riotId), label: riotId, root: true, games: matches.length, winRate: overall.winRate });
  for (const teammate of topTeammates) {
    nodeMeta.set(canonicalRiotId(teammate.name), { id: canonicalRiotId(teammate.name), label: teammate.name, root: false, games: teammate.games, winRate: teammate.winRate });
  }
  const edgeMap = new Map();
  for (const match of matches) {
    const participants = [...new Set(match.teamRiotIds.map(canonicalRiotId).filter((id) => networkNodeSet.has(id)))];
    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        const a = participants[i];
        const b = participants[j];
        const key = [a, b].sort().join('::');
        const edge = edgeMap.get(key) || { source: a, target: b, games: 0, wins: 0 };
        edge.games += 1;
        edge.wins += match.win ? 1 : 0;
        edgeMap.set(key, edge);
      }
    }
  }
  const networkEdges = [...edgeMap.values()]
    .map((edge) => ({ ...edge, winRate: safeDiv(edge.wins, edge.games), winRateText: fmtPct(safeDiv(edge.wins, edge.games)) }))
    .sort((a, b) => b.games - a.games || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const maxEdgeGames = Math.max(...networkEdges.map((edge) => edge.games), 1);

  const nodes = [...nodeMeta.values()].sort((a, b) => (b.root - a.root) || b.games - a.games || a.label.localeCompare(b.label));
  const ring = nodes.slice(1);
  const networkNodes = nodes.map((node, index) => {
    if (node.root) return { ...node, x: 0.5, y: 0.5, radius: 18 };
    const ringIndex = ring.findIndex((entry) => entry.id === node.id);
    const angle = (Math.PI * 2 * ringIndex) / Math.max(1, ring.length) - Math.PI / 2;
    const radiusNorm = 0.33 + ((ringIndex % 2) * 0.06);
    return {
      ...node,
      x: num(0.5 + Math.cos(angle) * radiusNorm, 4),
      y: num(0.5 + Math.sin(angle) * radiusNorm, 4),
      radius: 11 + Math.round((node.games / Math.max(...ring.map((entry) => entry.games), 1)) * 9)
    };
  });

  const firstSeen = matches[matches.length - 1]?.endedAt || matches[0]?.endedAt || Date.now();
  let quickRead = `fetched ${matches.length} League matches in the current Riot-visible window, from ${formatDateTime(firstSeen)} through ${formatDateTime(matches[0]?.endedAt || Date.now())}. `;
  if ((queueCounter.get('ARAM') || 0) / Math.max(1, matches.length) >= 0.75) {
    quickRead += 'This is overwhelmingly an ARAM-heavy sample, so the identity read is about fight patterns and champion comfort more than lane-phase macro.';
  } else {
    quickRead += 'This window has enough mode variety to read both champion comfort and broader game-shape tendencies.';
  }

  return {
    profile: {
      displayName: parseRiotId(riotId).gameName,
      tagline: parseRiotId(riotId).tagLine,
      riotId,
      canonicalKey: canonicalRiotId(riotId)
    },
    account: {
      puuid: account.puuid
    },
    summoner: { id: summoner.id, accountId: summoner.accountId, puuid: summoner.puuid, summonerLevel: summoner.summonerLevel },
    sampleSize: matches.length,
    deepSampleSize: matches.length,
    recentSampleSize: recentMatches.length,
    historyWindow: {
      firstMatchAt: firstSeen,
      lastMatchAt: matches[0]?.endedAt || Date.now(),
      firstMatchAtText: formatDateTime(firstSeen),
      lastMatchAtText: formatDateTime(matches[0]?.endedAt || Date.now())
    },
    overall: {
      ...overall,
      winRateText: fmtPct(overall.winRate),
      avgKdaRatio: num(avg(matches.map((match) => match.kdaRatio)), 2),
      avgCs: num(avg(matches.map((match) => match.cs)), 1),
      avgKp: avg(matches.map((match) => match.kp)),
      avgKpText: fmtPct(avg(matches.map((match) => match.kp))),
      avgDamage: num(avg(matches.map((match) => match.damage)), 0),
      medianDurationMinutes: num(median(matches.map((match) => match.durationMinutes)), 1)
    },
    recent: {
      ...recent,
      winRateText: fmtPct(recent.winRate),
      avgKdaRatio: num(avg(recentMatches.map((match) => match.kdaRatio)), 2),
      avgCs: num(avg(recentMatches.map((match) => match.cs)), 1),
      avgKp: avg(recentMatches.map((match) => match.kp)),
      avgKpText: fmtPct(avg(recentMatches.map((match) => match.kp)))
    },
    topChampions: topEntries(championCounter, 8),
    queueMix: topEntries(queueCounter, 6),
    roleMix: topEntries(roleCounter, 5),
    topTeammates,
    championIdentity: {
      truePool,
      highFamiliarityPoorResults,
      lowFamiliarityStrongResults,
      rows: championIdentityRows.filter((entry) => entry.games > 0).slice(0, 12),
      masteryCoverage: masteryRaw.length,
      masterySource: 'Riot champion-mastery-v4 + Data Dragon tags',
      classRows,
      primaryClassRows,
      classRead,
      comfortLeader: comfortLeader?.label || null,
      successLeader: successLeader?.label || null
    },
    signaturePlay: {
      signals: signatureSignals,
      note: 'signals are only surfaced when the match payload exposes the metric and the sample is big enough to compare against actual lobby peers.',
      radar: {
        note: 'radar axes are average within-lobby percentiles, scaled 0-100.',
        axes: radarAxes
      }
    },
    premadeSynergy: {
      rows: synergyRows,
      note: 'counts refer to how many of the player’s current top-10 teammates also appeared on the same team in that match.',
      read: synergyRead,
      soloishGames: soloish?.games || 0,
      stackedGames: stacked.games,
      stackedWinRate,
      stackedWinRateText: fmtPct(stackedWinRate)
    },
    playtimePersonality: {
      bands: playtimeBands,
      read: playtimeRead,
      bestBand: bestBand ? bestBand.label : null,
      worstBand: worstBand ? worstBand.label : null
    },
    worstEnemy: {
      rows: worstEnemies,
      note: 'enemy rows are correlation reads from the fetched match window, not a claim of a universal matchup truth.'
    },
    records: {
      note: `all records below come from the fetched Riot history window of ${matches.length} matches, not guaranteed full lifetime history.`,
      rows: records
    },
    teammateSampleSize: matches.length,
    network: {
      note: 'node map includes the root player plus top-10 teammates; edge thickness scales with how often that pair showed up on the same team in the fetched sample.',
      nodes: networkNodes,
      edges: networkEdges,
      maxEdgeGames
    },
    read: quickRead,
    matches: recentMatches.map((match) => ({
      ...match,
      kpPct: fmtPct(match.kp),
      teamDamageShareText: fmtPct(match.teamDamageShare)
    }))
  };
}

async function main() {
  await ensureDir(DATA_DIR);
  await ensureDir(OUT_DIR);
  await ensureDir(CACHE_DIR);

  const riotKey = (await fs.readFile(RIOT_KEY_PATH, 'utf8')).trim();
  const championData = buildChampionLookup(await fetchChampionData());

  const rootBundles = [];
  for (const riotId of ROOT_PLAYERS) {
    rootBundles.push({ riotId, ...(await fetchPlayerBundle(riotId, HISTORY_TARGET_ROOT, riotKey)) });
  }

  const rootTopDynamic = new Set(ROOT_PLAYERS.map(canonicalRiotId));
  const rootTopRows = [];
  for (const bundle of rootBundles) {
    const provisionalAllowed = Object.fromEntries(ROOT_PLAYERS.map((riotId) => [canonicalRiotId(riotId), { key: canonicalRiotId(riotId), riotId }]));
    const summary = summarizePlayer({ ...bundle, championLookup: championData, allowedPlayerMap: provisionalAllowed });
    const top5 = summary.topTeammates.slice(0, DYNAMIC_TOP).map((entry) => entry.name);
    rootTopRows.push({ riotId: bundle.riotId, top5 });
    for (const teammate of top5) rootTopDynamic.add(canonicalRiotId(teammate));
  }

  const dynamicIds = new Map();
  for (const riotId of ROOT_PLAYERS) dynamicIds.set(canonicalRiotId(riotId), riotId);
  for (const row of rootTopRows) {
    for (const teammate of row.top5) dynamicIds.set(canonicalRiotId(teammate), teammate);
  }

  const allowedPlayerMap = Object.fromEntries([...dynamicIds.entries()].map(([key, riotId]) => [key, { key, riotId }]));
  const allBundles = [...rootBundles];
  for (const [key, riotId] of dynamicIds.entries()) {
    if (ROOT_PLAYERS.map(canonicalRiotId).includes(key)) continue;
    allBundles.push({ riotId, ...(await fetchPlayerBundle(riotId, HISTORY_TARGET_ALLOWED, riotKey)) });
  }

  const players = {};
  for (const bundle of allBundles) {
    const summary = summarizePlayer({ ...bundle, championLookup: championData, allowedPlayerMap });
    players[summary.profile.canonicalKey] = summary;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    version: DATA_VERSION,
    defaultPlayerKey: canonicalRiotId(ROOT_PLAYERS[0]),
    rootPlayers: ROOT_PLAYERS,
    dynamicTargets: [...dynamicIds.values()],
    dynamicRules: {
      roots: ROOT_PLAYERS,
      derivedFromRootTopN: DYNAMIC_TOP,
      explanation: 'Allowed click-through targets are intentionally capped to the union of the two root players plus each root player’s top-5 most-played teammates from the fetched Riot sample.'
    },
    players
  };

  const summary = {
    generatedAt: payload.generatedAt,
    version: payload.version,
    dynamicTargets: payload.dynamicTargets,
    playerSummaries: Object.values(players).map((player) => ({
      riotId: player.profile.riotId,
      deepSampleSize: player.deepSampleSize,
      overallRecord: player.overall.record,
      overallWinRate: player.overall.winRateText,
      topChampion: player.topChampions[0] || null,
      topTeammate: player.topTeammates[0] || null,
      comfortClass: player.championIdentity.comfortLeader,
      successClass: player.championIdentity.successLeader
    }))
  };

  const lines = [
    '# Chuah dashboard v2 data refresh',
    '',
    `Generated: ${payload.generatedAt}`,
    `Allowed click-through targets (${payload.dynamicTargets.length}): ${payload.dynamicTargets.join(', ')}`,
    '',
    '## Player snapshots',
    ...Object.values(players).flatMap((player) => [
      `### ${player.profile.riotId}`,
      `- Riot-visible history window fetched: ${player.deepSampleSize} matches`,
      `- Window: ${player.historyWindow.firstMatchAtText} → ${player.historyWindow.lastMatchAtText}`,
      `- Overall record: ${player.overall.record} (${player.overall.winRateText})`,
      `- Top teammate: ${player.topTeammates[0] ? `${player.topTeammates[0].name} (${player.topTeammates[0].games} games)` : 'n/a'}`,
      `- Comfort class: ${player.championIdentity.comfortLeader || 'n/a'}`,
      `- Success class: ${player.championIdentity.successLeader || 'n/a'}`,
      `- Premade read: ${player.premadeSynergy.read}`,
      ''
    ])
  ];

  await fs.writeFile(path.join(DATA_DIR, 'chuah-data.json'), JSON.stringify(payload, null, 2));
  await fs.writeFile(path.join(OUT_DIR, 'chuah-summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(OUT_DIR, 'chuah-summary.md'), lines.join('\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
