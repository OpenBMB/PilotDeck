export default async function build({ createDeck, layouts, resolveDesignTokens }) {
  const tokens = await resolveDesignTokens({
    lang: 'zh-CN',
    profile: 'cross-platform-zh',
    density: 'presentation',
  });
  const pptx = await createDeck({
    title: 'PilotDeck 中文排版回归测试',
    subject: '验证中文、中英混排、表格和图表的原生 PowerPoint 输出',
    lang: 'zh-CN',
    tokens,
  });

  layouts.titleSlide(pptx, tokens, {
    eyebrow: '跨平台排版基线',
    title: '中文演示文稿也要保持可读、可改、可验证',
    subtitle: '覆盖中文换行、中英混排、百分比、数字与 PowerPoint 字体替换。',
    meta: 'PilotDeck · macOS / Windows · 2026',
  });

  layouts.twoColumnSlide(pptx, tokens, {
    kicker: '混合语言',
    title: '同一页面同时承载中文结论和 English metrics',
    left: {
      heading: '业务结论',
      items: ['用户满意度提升至 87%', 'Q2 重点是协作效率与移动体验', '关键行动需要明确负责人和截止时间'],
    },
    right: {
      heading: 'Delivery checks',
      items: ['Native charts remain editable', 'No missing Chinese glyphs', 'One verified artifact hash'],
    },
    footer: '中文排版回归测试',
    page: 2,
  });

  layouts.tableSlide(pptx, tokens, {
    kicker: '表格',
    title: '关键要求与验收结果保持一一对应',
    rows: [
      ['要求', '目标值', '验收状态'],
      ['中文字符完整', '100%', '通过'],
      ['跨平台可编辑', 'macOS + Windows', '通过'],
      ['关键内容覆盖', '11 / 9 / 7', '通过'],
      ['重复单位检测样例', '差距 −5元 元', '需复核'],
    ],
    source: 'PilotDeck self-test fixture',
    page: 3,
  });

  layouts.chartSlide(pptx, tokens, {
    kicker: '图表',
    title: '三个阶段的完成率持续提升',
    type: pptx.ChartType.bar,
    series: [{ name: '完成率', labels: ['规划', '生成', '验证'], values: [72, 86, 100] }],
    showValue: true,
    takeaway: '最终交付必须绑定同一个文件哈希。',
    source: '示例数据，仅用于回归测试',
    page: 4,
  });

  return pptx;
}
