// Shared runtime paths and diagnostics only. Configuration readers/writers keep
// their existing formats and ownership; no migration or normalization runs here.
const os=require('node:os'), path=require('node:path');
function resolveConfigHome(env=process.env) {
  const home=env.PILOT_HOME || path.join(os.homedir(),'.pilotdeck');
  return path.resolve(home==='~'?os.homedir():home.startsWith('~/')?path.join(os.homedir(),home.slice(2)):home);
}
module.exports={resolveConfigHome,...require('./errors.cjs')};
