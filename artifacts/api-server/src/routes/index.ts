import { Router, type IRouter } from "express";
import healthRouter from "./health";

// NOTE: videosRouter is intentionally NOT mounted here.
// It handles /api/videos and /video/:filename at the app level
// (in app.ts) because the streaming route must NOT be prefixed with /api.
const router: IRouter = Router();

router.use(healthRouter);

export default router;
