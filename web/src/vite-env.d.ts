/** The versions a report's provenance names (vite.config.ts define): this app, kit-ui, the core's and the viewer's revisions. */
declare const __VERSIONS__: { app: string; kitUi: string; core: string; viewer: string };
/** scheduler.yield, which the USD viewer's first-section warm-up looks for (its viewport.ts), as TypeScript 7's DOM lib
 *  declares it (they merge): this TypeScript's lacks it. Drop both once it has them. */
interface Scheduler { yield(): Promise<void> }
declare var scheduler: Scheduler;
