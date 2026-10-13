// Data bus: typed live streams, server-side fan-out over SSE, per-agent ACL.
// Components never fetch; they subscribe by stream id through the host, which
// holds ONE SSE connection per client and multiplexes every stream over it.

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class Bus {
  constructor() {
    this.streams = new Map();   // id -> {state, tick, every, acl, elapsed, version}
    this.clients = new Set();   // SSE responses
    this.log = [];              // last N diffs per stream for late joiners
  }
  define(id, { state, tick = null, every = 0, acl = ['*'] }) {
    this.streams.set(id, { state, tick, every, acl, elapsed: 0, version: 0 });
  }
  catalog() {
    return [...this.streams].map(([id, s]) => ({ id, live: !!s.tick, every: s.every, acl: s.acl, version: s.version }));
  }
  allowed(id, agentId) {
    const s = this.streams.get(id); if (!s) return false;
    return s.acl.includes('*') || s.acl.includes(agentId);
  }
  snapshot(id) { const s = this.streams.get(id); return s ? { state: structuredClone(s.state), version: s.version } : null; }
  attach(res, allowed = () => false) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    res.write(': connected\n\n');
    const client = { res, allowed };
    this.clients.add(client);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref();
    res.on('close', () => { clearInterval(heartbeat); this.clients.delete(client); });
  }
  broadcast(id, ev) {
    const s = this.streams.get(id);
    const payload = `event: stream\ndata: ${JSON.stringify({ id, ev, version: s.version, state: s.state })}\n\n`;
    for (const c of this.clients) if (c.allowed(id)) { if (c.res.writableLength > 1024 * 1024) c.res.destroy(); else c.res.write(payload); }
  }
  stop() { clearInterval(this.timer); for (const c of this.clients) c.res.end(); }
  start() {
    this.timer = setInterval(() => {
      for (const [id, s] of this.streams) {
        if (!s.tick) continue;
        s.elapsed += 1000;
        if (s.elapsed >= s.every) {
          s.elapsed = 0;
          const ev = s.tick(s.state);
          if (ev) { s.version++; this.broadcast(id, ev); }
        }
      }
    }, 1000).unref();
  }
}

export function defaultBus() {
  const bus = new Bus();
  bus.define('polls.us-2026.national', {
    state: { series: { A: [47.2, 47.5, 47.1, 47.8, 48.0, 47.6], B: [45.9, 45.4, 45.8, 45.1, 45.3, 45.7] } },
    every: 3000,
    tick: (s) => { for (const k of ['A', 'B']) { const a = s.series[k]; a.push(+(a.at(-1) + rnd(-0.5, 0.5)).toFixed(1)); if (a.length > 14) a.shift(); } return 'update'; },
  });
  bus.define('scores.nba.lal-bos', {
    state: { home: ['湖人', 71], away: ['凯尔特人', 68], q: 3, clock: '06:42', play: '湖人三分命中，追至 3 分差' },
    every: 2500,
    tick: (s) => {
      const who = Math.random() < 0.5 ? s.home : s.away; const pts = pick([2, 2, 3, 1]); who[1] += pts;
      const [m, sec] = s.clock.split(':').map(Number); let t = m * 60 + sec - Math.floor(rnd(8, 30));
      if (t < 0) { t = 720; s.q = Math.min(4, s.q + 1); }
      s.clock = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      const d = s.home[1] - s.away[1];
      s.play = `${who[0]}${pts === 3 ? '三分命中' : pts === 2 ? '两分得手' : '罚球命中'}，${d === 0 ? '战平' : (d > 0 ? '湖人' : '凯尔特人') + '领先 ' + Math.abs(d) + ' 分'}`;
      return 'score';
    },
  });
  const typhoonNext = [['12:40', '台风中心距岸 60 公里，风力 14 级'], ['13:20', '两处海堤出现险情，抢险队已到位'], ['14:05', '中心登陆，登陆点风速 45 m/s'], ['15:10', '主城区大面积停电，抢修中'], ['16:00', '台风减弱为强热带风暴，向内陆移动']];
  bus.define('story.typhoon.events', {
    state: { items: [['08:10', '气象台发布台风红色预警，预计傍晚登陆'], ['09:30', '沿海三市停课停工，渔船全部回港'], ['11:05', '高铁沿海段下午起停运']] },
    every: 6000,
    tick: (s) => { const i = s.items.length - 3; if (i < typhoonNext.length) { s.items.push(typhoonNext[i]); return 'append'; } return null; },
  });
  // licensed streams: only agents on the ACL may subscribe (the host enforces it)
  bus.define('video.clip', { state: { clips: { election: '60 秒看懂', nba: '第三节集锦', typhoon: '登陆点现场', film: '首映红毯' } }, acl: ['hype', 'narrator'] });
  bus.define('fashion.catalog.autumn', { state: { top: ['驼色针织开衫', '灰蓝衬衫', '黑色高领'], bottom: ['直筒牛仔', '烟管西裤', '针织半裙'], shoe: ['乐福鞋', '白色德训鞋', '短靴'] } });
  bus.define('travel.catalog.kyoto', { state: { days: [['清水寺（早到避人潮）', '二年坂抹茶', '祇园傍晚散步'], ['岚山竹林', '天龙寺', '嵯峨野小火车'], ['伏见稻荷', '锦市场午餐', '鸭川咖啡']], alt: ['南禅寺', '哲学之道', '三十三间堂', '锦市场', '京都塔', '下鸭神社', '宇治平等院'] } });
  return bus;
}
