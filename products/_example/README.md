# 产品定制示例（_example）

这是一个产品定制目录的模板。复制此目录并重命名为客户标识即可开始。

```bash
cp -r products/_example products/customer-a
```

## 目录说明

```
_example/
  plugins/
    example-compliance/       ← 示例插件：合规审计钩子
      plugin.json
      hooks/hooks.json
      commands/audit-report.md
  config/
    pilotdeck.yaml            ← 覆盖配置示例
  brand/
    theme.json                ← 品牌主题覆盖（待 BrandConfig 贡献点就绪后生效）
  README.md                   ← 本文件
```

## 部署方式

1. 将 `plugins/` 下的插件目录链接到 `~/.pilotdeck/plugins/` 或项目级 `.pilotdeck/plugins/`
2. 将 `config/pilotdeck.yaml` 合并到目标环境的配置
3. 启动 PilotDeck，插件自动发现并加载

```bash
# 示例：软链接插件到全局目录
ln -s $(pwd)/products/customer-a/plugins/example-compliance ~/.pilotdeck/plugins/example-compliance

# 启动
npm run server
```
