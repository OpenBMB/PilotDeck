/**
 * Mirror the plugin-owned StaffDeckLocaleBoundary so in-tree composition
 * pages (staffdeck-sop.tsx, pilotdeck-sop.tsx) and third-party plugin pages
 * all share one locale boundary — including the zh→en catalog that lives
 * inside the plugin directory (staffdeck-shared/vendor/locale/).
 *
 * No translation data lives in the main source tree; the plugin is the
 * canonical owner of both the catalog and the boundary component.
 */
export { default } from '../../../../plugins/staffdeck-shared/vendor/locale/StaffDeckLocaleBoundary';
