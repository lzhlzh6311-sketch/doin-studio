import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

/**
 * 让 `app.get/post/...` 上的 async 处理器抛错时交给 Express 的错误处理链。
 *
 * Express 4 不会接住 async 处理器返回的被拒 Promise：没写 try/catch 的路由（例如
 * `DELETE /api/jobs/:id`）一旦底层抛错，请求就永远挂着，同时产生一个未处理的拒绝 ——
 * 在独立后端里，Node 的默认行为是直接让进程退出。这里统一把拒绝转给 `next(error)`，
 * 由 app.ts 末尾的兜底错误处理回安全的 JSON。已有 try/catch 的处理器不受影响。
 */
const METHODS = ["get", "post", "put", "patch", "delete", "all"] as const;

export function wrapAsyncHandler<T extends RequestHandler>(handler: T): T {
  // 四个参数的是错误处理中间件，签名不同，原样保留。
  if (typeof handler !== "function" || handler.length === 4) return handler;
  const wrapped = function (this: unknown, req: Request, res: Response, next: NextFunction) {
    try {
      const result = (handler as RequestHandler).call(this, req, res, next) as unknown;
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(undefined, next);
      }
      return result;
    } catch (error) {
      next(error);
    }
  };
  return wrapped as unknown as T;
}

export function catchAsyncRouteErrors(app: Express): void {
  for (const method of METHODS) {
    const original = (app[method] as (...args: unknown[]) => unknown).bind(app);
    (app as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      // `app.get("setting")` 是读取设置，不是注册路由。
      if (method === "get" && args.length === 1) return original(...args);
      return original(...args.map((arg) => (typeof arg === "function" ? wrapAsyncHandler(arg as RequestHandler) : arg)));
    };
  }
}
