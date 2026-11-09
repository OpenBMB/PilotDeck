# Product customization example

Copy this directory to a product-specific name before customizing it. It demonstrates plugin commands/hooks, configuration overrides and a proposed branding payload.

```sh
cp -r products/_example products/customer-a
```

- plugins/example-compliance: a sample compliance plugin and audit command.
- config/pilotdeck.yaml: configuration overrides to merge into the target installation.
- brand/theme.json: a branding example, activated only when the matching contribution point exists.

Link the product plugin into the global or project-level .pilotdeck/plugins directory, merge the configuration, then run `npm run server`. Plugin Markdown commands are runtime inputs and should be preserved with their manifest and hooks. This example is not an automatically applied customer configuration.
