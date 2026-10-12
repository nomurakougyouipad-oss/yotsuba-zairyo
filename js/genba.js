// 現場のスマホ（index.html）。いまは土台だけ
import { $, initTheme, runChecks } from "./common.js";

initTheme();
runChecks($("#checks"), { sw: true });
