import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('/Users/gdragon/.openclaw/workspace/chuahpstix-league-viz');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'out');
const RIOT_KEY_PATH = path.join(process.env.HOME || '', '.openclaw', 'secrets', 'riot_api_key');

const LEAGUE_ACCOUNT = { gameName: 'chuahpstix', tagLine: 'NA1' };
const LEAGUE_RECENT_COUNT = 10;
const LEAGUE_HISTORY_TARGET = 300;
const LEAGUE_HISTORY_PAGE = 100;
const LEAGUE_TEAMMATE_TOP = 10;
const TACTICS_TOOLS_URL = 'https://tactics.tools/player/na/chuahpstix/NA1';
const TFT_TARGET_COUNT = 30;
const LOCAL_TIMEZONE = 'America/New_York';

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
  return Number(value.toFixed(digits));
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

function safeDiv(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
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

async function fetchChampionData() {
  const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json', {
    headers: { 'User-Agent': 'Mozilla/5.0 OpenClaw/1.0' }
  }).then((response) => response.json());
  const version = versions[0];
  const payload = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0 OpenClaw/1.0' }
  }).then((response) => response.json());

  const byId = new Map();
  for (const champion of Object.values(payload.data)) {
    byId.set(Number(champion.key), champion.name);
  }

  return { version, byId };
}

async function fetchLeague(key) {
  const account = await riotGet(
    `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(LEAGUE_ACCOUNT.gameName)}/${encodeURIComponent(LEAGUE_ACCOUNT.tagLine)}`,
    key
  );
  const summoner = await riotGet(`https://na1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`, key);
  const championData = await fetchChampionData();
  const masteryRaw = await riotGet(`https://na1.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${account.puuid}`, key);
  const masteryByName = new Map(
    masteryRaw.map((entry) => [
      championData.byId.get(entry.championId) || `Champion ${entry.championId}`,
      {
        championId: entry.championId,
        championLevel: entry.championLevel,
        championPoints: entry.championPoints,
        lastPlayTime: entry.lastPlayTime
      }
    ])
  );

  const matchIds = [];
  for (let start = 0; start < LEAGUE_HISTORY_TARGET; start += LEAGUE_HISTORY_PAGE) {
    const batch = await riotGet(
      `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=${start}&count=${LEAGUE_HISTORY_PAGE}`,
      key
    );
    matchIds.push(...batch);
    if (batch.length < LEAGUE_HISTORY_PAGE) break;
    await sleep(1200);
  }

  const matches = [];
  const teammateCounter = new Map();
  for (const [index, matchId] of matchIds.entries()) {
    const raw = await riotGet(`https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`, key);
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
      cc: raw.info.participants.map((participant) => getChallenges(participant).enemyChampionImmobilizations).filter((value) => Number.isFinite(value)),
      skillshots: raw.info.participants.map((participant) => getChallenges(participant).skillshotsDodged).filter((value) => Number.isFinite(value)),
      steals: raw.info.participants.map((participant) => getChallenges(participant).epicMonsterSteals).filter((value) => Number.isFinite(value))
    };

    matches.push({
      id: matchId,
      index,
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
      cs,
      damage: me.totalDamageDealtToChampions,
      damageTaken: me.totalDamageTaken,
      damageMitigated: me.damageSelfMitigated,
      gold: me.goldEarned,
      visionScore: me.visionScore,
      wardsPlaced: me.wardsPlaced,
      wardsKilled: me.wardsKilled,
      durationSeconds: raw.info.gameDuration,
      durationMinutes,
      endedAt: timestamp,
      endedAtText: formatDateTime(timestamp),
      hour,
      timeBand: timeBandLabel(hour),
      role: me.teamPosition || me.individualPosition || 'Unknown',
      teamKills,
      teamDamageShare: challenges.teamDamagePercentage ?? safeDiv(me.totalDamageDealtToChampions, Math.max(1, team.reduce((sum, participant) => sum + participant.totalDamageDealtToChampions, 0))),
      kp: challenges.killParticipation ?? safeDiv(me.kills + me.assists, teamKills),
      dpm: challenges.damagePerMinute ?? safeDiv(me.totalDamageDealtToChampions, durationMinutes),
      visionPerMinute: challenges.visionScorePerMinute ?? safeDiv(me.visionScore, durationMinutes),
      takedownsFirstXMinutes: challenges.takedownsFirstXMinutes ?? null,
      earlyTakedowns: challenges.takedownsFirstXMinutes ?? null,
      ccScore: challenges.enemyChampionImmobilizations ?? null,
      skillshotsDodged: challenges.skillshotsDodged ?? null,
      skillshotsHit: challenges.skillshotsHit ?? null,
      soloKills: challenges.soloKills ?? 0,
      quickSoloKills: challenges.quickSoloKills ?? 0,
      multikills: challenges.multikills ?? 0,
      objectiveSteals: me.objectivesStolen ?? 0,
      epicMonsterSteals: challenges.epicMonsterSteals ?? 0,
      enemyChampion,
      percentiles: {
        kp: percentileRank(metricValues.kp, challenges.killParticipation ?? safeDiv(me.kills + me.assists, teamKills)),
        dpm: percentileRank(metricValues.dpm, challenges.damagePerMinute ?? safeDiv(me.totalDamageDealtToChampions, durationMinutes)),
        teamDamage: percentileRank(metricValues.teamDamage, challenges.teamDamagePercentage ?? 0),
        early: percentileRank(metricValues.early, challenges.takedownsFirstXMinutes ?? 0),
        vision: percentileRank(metricValues.vision, challenges.visionScorePerMinute ?? safeDiv(me.visionScore, durationMinutes)),
        cc: percentileRank(metricValues.cc, challenges.enemyChampionImmobilizations ?? 0),
        skillshots: percentileRank(metricValues.skillshots, challenges.skillshotsDodged ?? 0),
        steals: percentileRank(metricValues.steals, challenges.epicMonsterSteals ?? 0)
      },
      kdaText: `${me.kills}/${me.deaths}/${me.assists}`
    });

    await sleep(90);
  }

  const recentMatches = matches.slice(0, LEAGUE_RECENT_COUNT);
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
    const champion = championData.byId.get(raw.championId) || `Champion ${raw.championId}`;
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

  const championIdentity = [...championRows.values()]
    .map((entry) => {
      const mastery = masteryByName.get(entry.champion) || null;
      const familiarityScore = (entry.games / maxGames) * 0.55 + ((mastery?.championPoints || 0) / maxMastery) * 0.45;
      const winRate = safeDiv(entry.wins, Math.max(1, entry.games));
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
        avgKp: safeDiv(avg(entry.kp), 1),
        lastPlayedAt: entry.lastPlayedAt,
        lastPlayedAtText: entry.lastPlayedAt ? formatDateTime(entry.lastPlayedAt) : null,
        masteryLevel: mastery?.championLevel || 0,
        masteryPoints: mastery?.championPoints || 0,
        familiarityScore,
        poolWeight: num(familiarityScore * 100, 1)
      };
    })
    .sort((a, b) => b.familiarityScore - a.familiarityScore || b.games - a.games || a.champion.localeCompare(b.champion));

  const truePool = championIdentity.filter((entry) => entry.games > 0).slice(0, 6);
  const highFamiliarityPoorResults = championIdentity
    .filter((entry) => entry.games >= 2 && entry.masteryPoints > 0)
    .filter((entry) => entry.familiarityScore >= 0.35 && entry.winRate <= overall.winRate - 0.08)
    .sort((a, b) => (a.winRate - b.winRate) || (b.masteryPoints - a.masteryPoints))
    .slice(0, 3);
  const lowFamiliarityStrongResults = championIdentity
    .filter((entry) => entry.games >= 2)
    .filter((entry) => entry.familiarityScore <= 0.3 && entry.winRate >= overall.winRate + 0.1)
    .sort((a, b) => (b.winRate - a.winRate) || (a.masteryPoints - b.masteryPoints))
    .slice(0, 3);

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

  const records = [
    { key: 'kills', label: 'highest kills', better: 'max' },
    { key: 'assists', label: 'highest assists', better: 'max' },
    { key: 'deaths', label: 'most deaths', better: 'max' },
    { key: 'damage', label: 'highest damage', better: 'max' },
    { key: 'cs', label: 'highest CS', better: 'max' },
    { key: 'kp', label: 'highest kill participation', better: 'max' },
    { key: 'kdaRatio', label: 'best KDA', better: 'max' },
    { key: 'visionPerMinute', label: 'best vision/min', better: 'max' }
  ].map((definition) => {
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
    .slice(0, LEAGUE_TEAMMATE_TOP)
    .map((entry) => ({
      ...entry,
      record: `${entry.wins}-${entry.losses}`,
      winRate: entry.wins / Math.max(1, entry.games),
      winRateText: fmtPct(entry.wins / Math.max(1, entry.games), 0)
    }));

  const roleCounter = new Map();
  const firstSeen = matches[matches.length - 1]?.endedAt || matches[0]?.endedAt || Date.now();
  for (const match of matches) {
    roleCounter.set(match.role, (roleCounter.get(match.role) || 0) + 1);
  }

  let quickRead = `fetched ${matches.length} League matches in the current Riot-visible window, from ${formatDateTime(firstSeen)} through ${formatDateTime(matches[0]?.endedAt || Date.now())}. `;
  if ((queueCounter.get('ARAM') || 0) / Math.max(1, matches.length) >= 0.75) {
    quickRead += 'This is overwhelmingly an ARAM-heavy sample, so the identity read is about fight patterns and champion comfort more than lane-phase macro.';
  } else {
    quickRead += 'This window has enough mode variety to read both champion comfort and broader game-shape tendencies.';
  }

  return {
    account,
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
      rows: championIdentity.filter((entry) => entry.games > 0).slice(0, 12),
      masteryCoverage: masteryRaw.length,
      masterySource: 'Riot champion-mastery-v4'
    },
    signaturePlay: {
      signals: signatureSignals,
      note: 'signals are only surfaced when the match payload exposes the metric and the sample is big enough to compare against actual lobby peers.'
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
    read: quickRead,
    matches: recentMatches.map((match) => ({
      ...match,
      kpPct: fmtPct(match.kp),
      teamDamageShareText: fmtPct(match.teamDamageShare)
    }))
  };
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
      deepSampleSize: league.deepSampleSize,
      recentRecord: league.recent.record,
      recentWinRate: league.recent.winRateText,
      overallRecord: league.overall.record,
      overallWinRate: league.overall.winRateText,
      historyWindow: league.historyWindow,
      topChampions: league.topChampions,
      topTeammates: league.topTeammates.slice(0, 5),
      signaturePlay: league.signaturePlay.signals,
      worstEnemy: league.worstEnemy.rows.slice(0, 3)
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
    '# Chuah app data refresh',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    '## League deep sample',
    `- Riot-visible history window fetched: ${league.deepSampleSize} matches`,
    `- Window: ${league.historyWindow.firstMatchAtText} → ${league.historyWindow.lastMatchAtText}`,
    `- Overall record: ${league.overall.record} (${league.overall.winRateText})`,
    `- Recent 10: ${league.recent.record} (${league.recent.winRateText})`,
    `- Signature play callouts: ${league.signaturePlay.signals.map((signal) => `${signal.label} (${signal.avgPercentileText})`).join('; ') || 'none strong enough yet'}`,
    `- Worst enemy read: ${league.worstEnemy.rows[0] ? `${league.worstEnemy.rows[0].champion} (${league.worstEnemy.rows[0].lossRateText} loss rate over ${league.worstEnemy.rows[0].games} games)` : 'n/a'}`,
    '',
    '## TFT public sample',
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
