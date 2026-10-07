/**
 * 长操作的「取消」入口（纯逻辑，便于用例守）。
 *
 * 背景：渲染端默认请求超时 16 分钟，早先没有任何中断入口 —— 「创建文章包」等请求挂住时，
 * 用户只能干等。这里给每个页面/弹窗一份 AbortController 管理：
 * - `begin()` 开始一次新操作，返回它的 `signal`（会先中止上一次仍在途的操作）；
 * - `cancel()` 是界面「取消」按钮的动作；
 * - `dispose()` 在组件卸载时调用，离开页面即不再等待。
 *
 * ⚠️ 取消只是**停止等待**：已经到达后端的请求可能仍会在后台完成并写入结果，
 * 界面文案必须如实说明这一点，并引导用户刷新核对。
 */
export class CancellableOperation {
  private controller: AbortController | null = null;

  get active(): boolean {
    return this.controller !== null && !this.controller.signal.aborted;
  }

  begin(): AbortSignal {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    return controller.signal;
  }

  /** 操作正常结束（成功或失败）后调用；只清理仍属于这次操作的 controller。 */
  finish(signal: AbortSignal): void {
    if (this.controller?.signal === signal) this.controller = null;
  }

  /** 中止当前操作。返回是否真的有操作被中止。 */
  cancel(): boolean {
    const controller = this.controller;
    this.controller = null;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  dispose(): void {
    this.cancel();
  }
}

export const CANCELLED_NOTICE = '已取消等待。若服务器已开始处理，结果可能仍会写入，请稍后刷新核对。';
