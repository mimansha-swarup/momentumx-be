// Composition root.
//
// Every repository and service is constructed EXACTLY ONCE, here, and imported
// by the route files. Before this, each of the seven route files rebuilt the
// object graph it needed — 51 constructions of ~15 classes, with
// `VideoProjectService` and `ContentRepository` each built five times.
//
// Nothing here is stateful, so the duplication was never a correctness bug. It
// was a change-amplification bug: adding one constructor parameter to
// `VideoProjectService` (the `linkResource` ownership fix, Phase 01 item 6)
// required editing five route files and two test files. The phases ahead do that
// repeatedly — Phase 05 threads `req.accountId` through, Phase 06 changes
// repository signatures, Phase 08 injects billing into the generation seam — so
// each of those would have paid the same seven-file tax.
//
// This is a composition root, deliberately NOT a DI framework: no container
// library, no decorators, no reflection, no service registry. Just `new` in
// dependency order, exported as consts. If it ever needs to be more than that,
// it should earn it.
//
// Ordering matters — a const must be declared before it is used as an argument.

import AccountRepository from "./repository/account.repository.js";
import ContentRepository from "./repository/content.repository.js";
import HooksRepository from "./repository/hooks.repository.js";
import PackagingRepository from "./repository/packaging.repository.js";
import ResearchRepository from "./repository/research.repository.js";
import UserRepository from "./repository/user.repository.js";
import VideoProjectRepository from "./repository/video-project.repository.js";

import AccountService from "./service/account.service.js";
import ContentService from "./service/content.service.js";
import ContextService from "./service/context.service.js";
import HooksService from "./service/hooks.service.js";
import PackagingService from "./service/packaging.service.js";
import ResearchContextService from "./service/research-context.service.js";
import ResearchService from "./service/research.service.js";
import StepRunner from "./service/step-runner.js";
import UserService from "./service/user.service.js";
import VideoProjectService from "./service/video-project.service.js";

import HooksController from "./controller/hooks.controller.js";
import IdeaController from "./controller/idea.controller.js";
import PackagingController from "./controller/packaging.controller.js";
import ResearchController from "./controller/research.controller.js";
import ScriptController from "./controller/script.controller.js";
import UserController from "./controller/user.controller.js";
import AccountController from "./controller/account.controller.js";
import VideoProjectController from "./controller/video-project.controller.js";

// --- Repositories ----------------------------------------------------------

export const accountRepository = new AccountRepository();
export const contentRepository = new ContentRepository();
export const hooksRepository = new HooksRepository();
export const packagingRepository = new PackagingRepository();
export const researchRepository = new ResearchRepository();
export const userRepository = new UserRepository();
export const videoProjectRepository = new VideoProjectRepository();

// --- Services --------------------------------------------------------------

// Phase 03, narrowed by Phase 06. It no longer stamps writes — the account now
// arrives on the request as `req.accountId`, already membership-checked. What is
// left is the lazy first-mint and the tombstone repair, both used only by
// `accountMiddleware`.
export const accountService = new AccountService(
  accountRepository,
  userRepository,
  videoProjectRepository
);

export const videoProjectService = new VideoProjectService(
  videoProjectRepository,
  contentRepository,
  packagingRepository,
  hooksRepository
);

export const contextService = new ContextService(
  userRepository,
  contentRepository,
  hooksRepository,
  videoProjectService
);

export const researchContextService = new ResearchContextService(researchRepository);

// `researchContext` is optional on ContentService, and the two route files that
// built this class disagreed about it: ideas.route passed it, scripts.route did
// not. No live bug — only `generateIdeas` reads it, and scripts.route registers
// no idea endpoints — but it meant the same class had two capability levels
// depending on which router you arrived through. Research degrades silently by
// design (see the degradation contract in ai-generation-patterns.md), so a
// missing wire and a YouTube outage look identical. One instance, fully wired.
export const contentService = new ContentService(
  contentRepository,
  userRepository,
  videoProjectService,
  researchContextService
);

// The generation seam (Phase 01b). One instance, shared by every service that
// makes a model call — it is stateless, and Phase 08 attaches billing here rather
// than at twelve call sites.
export const stepRunner = new StepRunner(videoProjectRepository);

export const hooksService = new HooksService(
  hooksRepository,
  videoProjectService,
  contextService,
  stepRunner
);

export const packagingService = new PackagingService(
  packagingRepository,
  videoProjectService,
  contextService,
  researchContextService
);

export const researchService = new ResearchService(researchRepository, userRepository);

// ponytail: UserService still builds its own ExtractService/ExtractRepository
// internally (`user.service.ts:27`) rather than taking them as parameters, so
// that one dependency is not visible here. Left as-is — injecting it changes the
// constructor and its two test suites, which is a separate change from this one.
export const userService = new UserService(userRepository);

// --- Controllers -----------------------------------------------------------

export const accountController = new AccountController(accountService);
export const hooksController = new HooksController(hooksService);
export const ideaController = new IdeaController(contentService);
export const packagingController = new PackagingController(packagingService);
export const researchController = new ResearchController(researchService);
export const scriptController = new ScriptController(contentService);
export const userController = new UserController(userService);
export const videoProjectController = new VideoProjectController(videoProjectService);
