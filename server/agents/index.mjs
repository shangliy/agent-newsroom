// Agent protocol.
//   build({story, reader, catalog}) -> scene        (cacheable per reader cluster)
//   answer({story, reader, question, scene}) -> block   (never cached)
// A scene is {version, motion, scene:[{component:"name@major", data?, props?}]}.
// Agents are plain modules here; in production each is an HTTP endpoint with the
// same two routes, and `llm.mjs` shows where a model call slots in.
import { SUMMARY } from '../stories.mjs';
import { maybeLLM } from './llm.mjs';

const summary = (s) => ({ component: 'summary@1', props: { text: SUMMARY[s.id], sources: s.sources } });
const chart = { component: 'live-chart@2', data: 'polls.us-2026.national', props: { compare: ['A 党', 'B 党'] } };
const board = { component: 'scoreboard@1', data: 'scores.nba.lal-bos' };
const tl = { component: 'timeline-live@1', data: 'story.typhoon.events' };
const picker = (note) => ({ component: 'outfit-picker@1', data: 'fashion.catalog.autumn', props: { note } });
const itin = { component: 'itinerary@1', data: 'travel.catalog.kyoto' };
const cmp = (cols) => ({ component: 'compare@1', props: { cols } });
const quote = (text, source) => ({ component: 'quote@1', props: { text, source } });
const video = (id, title) => ({ component: 'video@1', data: 'video.clip', props: { clip: id, title } });

export const AGENTS = {
  datadesk: { name: 'DataDesk', version: '1.0.0', style: '图表优先',
    build({ story: s, reader }) {
      const sc = { version: 1, motion: 'none', scene: [] };
      if (s.id === 'election') sc.scene.push(chart, cmp([{ title: '摇摆州', rows: [['宾州', '+1.2'], ['亚利桑那', '-0.4'], ['威斯康星', '+0.3']] }, { title: '样本', rows: [['民调数', '12'], ['样本量', '18,400'], ['误差', '±1.1']] }]));
      else if (s.id === 'nba') sc.scene.push(board, cmp([{ title: '湖人', rows: [['投篮', '48%'], ['三分', '11/26'], ['篮板', '31']] }, { title: '凯尔特人', rows: [['投篮', '45%'], ['三分', '9/24'], ['篮板', '34']] }]));
      else if (s.id === 'typhoon') sc.scene.push(cmp([{ title: '强度', rows: [['中心风速', '45 m/s'], ['等级', '14 级']] }, { title: '影响', rows: [['停课城市', '3'], ['高铁停运', '14:00 起']] }]), tl);
      else if (s.id === 'film') sc.scene.push(cmp([{ title: '《海鸥》', rows: [['预售', '1.8 亿'], ['评分', '8.4'], ['排片', '41%']] }, { title: '同档期均值', rows: [['预售', '0.6 亿'], ['评分', '7.1'], ['排片', '18%']] }]));
      else if (s.id === 'outfit') sc.scene.push(cmp([{ title: '针织开衫路线', rows: [['预算', '¥680'], ['气温', '12–18°']] }, { title: '衬衫路线', rows: [['预算', '¥420'], ['气温', '15–22°']] }]), picker('按价格和气温筛过的组合'));
      else sc.scene.push(cmp([{ title: '清晨出发', rows: [['清水寺人流', '低'], ['步行', '6.2 km']] }, { title: '午后出发', rows: [['清水寺人流', '高'], ['步行', '4.1 km']] }]), itin);
      if (reader.cluster !== 'skim') sc.scene.push(summary(s));
      return sc;
    },
    answer({ story: s, question, bus }) {
      const latest = s.id === 'nba' ? `${bus.snapshot('scores.nba.lal-bos').state.home[1]}:${bus.snapshot('scores.nba.lal-bos').state.away[1]}` : s.id === 'election' ? bus.snapshot('polls.us-2026.national').state.series.A.at(-1) + '%' : '见上表';
      return cmp([{ title: '你问的', rows: [[question.slice(0, 12), '']] }, { title: '数据回答', rows: [['最新值', latest], ['更新于', '刚刚']] }]);
    } },
  narrator: { name: 'Narrator', version: '1.1.0', style: '时间线 + 引用',
    build({ story: s }) {
      const sc = { version: 1, motion: 'none', scene: [summary(s)] };
      if (s.id === 'typhoon') sc.scene.push(tl);
      else if (s.id === 'election') sc.scene.push(quote('差距缩小主要来自独立选民的回流，而不是基本盘的流失。', '民调汇总'), chart);
      else if (s.id === 'nba') sc.scene.push(quote('第三节我们换了防守策略，让他们的三分手离开舒适区。', '赛场速报'), board);
      else if (s.id === 'film') sc.scene.push(quote('这是今年第一部让影院里安静了三秒才响起掌声的电影。', '影评人周刊'));
      else if (s.id === 'outfit') sc.scene.push(quote('通勤穿搭的核心不是单品，是温差。', '穿搭数据库'), picker('按故事里的温差逻辑选的'));
      else sc.scene.push(quote('京都的秘诀只有一个：比旅行团早一小时。', '旅行库'), itin);
      return sc;
    },
    answer({ story: s, question }) { return summary(s); } },
  hype: { name: 'Hype', version: '0.9.0', style: '动效 + 视频',
    build({ story: s, reader }) {
      const sc = { version: 1, motion: 'editorial-reveal', scene: [video(s.id, { election: '60 秒看懂', nba: '第三节集锦', typhoon: '登陆点现场', film: '首映红毯' }[s.id] || '60 秒看懂')] };
      if (s.id === 'nba') sc.scene.push(board); else if (s.id === 'election') sc.scene.push(chart);
      else if (s.id === 'film') sc.scene.push(quote('预售 1.8 亿，评分 8.4，口碑爆了。', '票房通'));   // <- fails verification on purpose: "口碑爆了" is not in the source
      else if (s.id === 'typhoon') sc.scene.push(tl); else if (s.id === 'outfit') sc.scene.push(picker('本周最火的三种组合')); else sc.scene.push(itin);
      if (reader.cluster !== 'skim') sc.scene.push(summary(s));
      return sc;
    },
    answer({ story: s, question }) { return video(s.id, '回答：' + question.slice(0, 10)); } },
  stylist: { name: 'Stylist', version: '1.0.0', style: '互动优先',
    build({ story: s }) {
      const sc = { version: 1, motion: 'none', scene: [] };
      if (s.id === 'outfit') sc.scene.push(picker('点一下就换，或者让我重新生成'));
      else if (s.id === 'kyoto') sc.scene.push(itin);
      else if (s.id === 'election') sc.scene.push(cmp([{ title: '如果你关心经济', rows: [['A 党', '减税'], ['B 党', '补贴']] }, { title: '如果你关心医保', rows: [['A 党', '市场化'], ['B 党', '扩面']] }]), chart);
      else if (s.id === 'nba') sc.scene.push(board);
      else if (s.id === 'typhoon') sc.scene.push(cmp([{ title: '你在沿海', rows: [['现在', '备水备电'], ['傍晚', '不要外出']] }, { title: '你在内陆', rows: [['明天', '暴雨'], ['出行', '查高铁']] }]), tl);
      else sc.scene.push(cmp([{ title: '适合你 if', rows: [['喜欢慢片', '✓'], ['周末有空', '✓']] }, { title: '不适合 if', rows: [['要爽片', '✗'], ['带小孩', '✗']] }]));
      sc.scene.push(summary(s));
      return sc;
    },
    answer({ question }) { return cmp([{ title: '方案 1', rows: [[question.slice(0, 8), '保守']] }, { title: '方案 2', rows: [[question.slice(0, 8), '大胆']] }]); } },
};

// Optional LLM path: when ANTHROPIC_API_KEY is set, Narrator's summary text is
// rewritten by a model from the cited sources, and the verifier still has to pass it.
export async function runBuild(agentId, ctx) {
  const scene = structuredClone(await AGENTS[agentId].build(ctx));
  if (agentId === 'narrator') await maybeLLM(scene, ctx);
  return scene;
}
