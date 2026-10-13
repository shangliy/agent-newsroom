// Deliberately fictional; preview-only. Never pass these to the live scheduler.
export const fixtures = {
  papers: [{ paper: { id: '0000.00000', title: 'Example Paper: Memory for Small Agents', summary: 'Synthetic fixture about evaluating memory. No real experimental result is asserted.', githubRepo: 'https://github.com/example/fictional-paper', publishedAt: '2026-01-01T00:00:00Z' } }],
  twitter: { data: [{ id: '1000000000000000000', text: 'Fictional test discussion about useful agent workflows.', created_at: '2026-01-01T00:00:00Z', public_metrics: { like_count: 42, retweet_count: 5 } }] },
  news: { news_results: [{ title: '虚构示例：城市图书馆开放新的阅读空间', link: 'https://example.com/fictional-library', snippet: '仅用于测试，不是真实新闻。', source: { name: '示例来源' }, iso_date: '2026-01-01T00:00:00Z' }] },
  youtube: { items: [{ id: 'DEMOvideo01', snippet: { title: '虚构示例：用镜头记录一个安静的早晨', description: '非真实视频。', channelTitle: '示例频道', publishedAt: '2026-01-01T00:00:00Z' }, statistics: { viewCount: '100' } }] },
  travel: { entries: [{ id: 'fictional-weekend', title: '把周末留给河边的一段路', fictional: true, notes: '虚构示例：沿着河边慢慢散步，在树荫下翻几页书。没有真实地点、费用或行程推荐。', photos: [], authorization: { public: true, statement: '这是为协议测试编写的虚构素材，不包含个人记录。' } }] },
};
