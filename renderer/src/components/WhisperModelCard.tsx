import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, AlertCircle } from 'lucide-react';
import { apiClient, type WhisperModelStatus } from '../services/api';
import { Button } from './ui/Button';

const formatMb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function whisperModelSummary(model: WhisperModelStatus | null): { tone: 'ok' | 'busy' | 'warn' | 'idle'; text: string } {
  if (!model) return { tone: 'idle', text: '正在读取语音模型状态…' };
  switch (model.state) {
    case 'ready':
      return { tone: 'ok', text: '语音模型已就绪，转录在本机离线完成。' };
    case 'downloading': {
      const percent = model.totalBytes > 0 ? Math.min(99, Math.floor((model.downloadedBytes / model.totalBytes) * 100)) : 0;
      return { tone: 'busy', text: `正在下载语音模型 ${percent}%（${formatMb(model.downloadedBytes)} / ${formatMb(model.totalBytes)}）` };
    }
    case 'failed':
      return { tone: 'warn', text: model.error || '语音模型下载失败，请重试。' };
    default:
      return {
        tone: 'idle',
        text: model.downloadedBytes > 0
          ? `语音模型还没下载完（已下 ${formatMb(model.downloadedBytes)}），可继续下载。`
          : `语音模型约 ${formatMb(model.totalBytes)}，第一次转录时会自动下载，也可以现在先下好。`,
      };
  }
}

/** 设置 → 语音转录：语音模型状态与手动下载（安装包不再自带模型）。 */
export function WhisperModelCard() {
  const [model, setModel] = useState<WhisperModelStatus | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setModel(await apiClient.getWhisperModel()); setError(''); }
    catch { setError('读取语音模型状态失败'); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (model?.state !== 'downloading') return;
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(timer);
  }, [model?.state, refresh]);

  const start = async () => {
    try { setModel(await apiClient.downloadWhisperModel()); setError(''); }
    catch { setError('无法开始下载，请稍后重试'); }
  };

  const summary = whisperModelSummary(model);
  const percent = model && model.totalBytes > 0 ? Math.min(100, (model.downloadedBytes / model.totalBytes) * 100) : 0;
  const Icon = summary.tone === 'ok' ? CheckCircle2 : summary.tone === 'busy' ? Loader2 : summary.tone === 'warn' ? AlertCircle : Download;

  return (
    <div className="rounded-lg border border-line bg-canvas p-4" data-testid="whisper-model-card">
      <div className="flex flex-wrap items-center gap-3">
        <Icon size={18} className={`shrink-0 ${summary.tone === 'ok' ? 'text-success' : summary.tone === 'warn' ? 'text-warning' : 'text-accent'} ${summary.tone === 'busy' ? 'animate-spin' : ''}`} aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-ink">{error || summary.text}</p>
        {model && model.state !== 'ready' && model.state !== 'downloading' && (
          <Button size="sm" onClick={() => { void start(); }}>{model.downloadedBytes > 0 || model.state === 'failed' ? '继续下载' : '立即下载'}</Button>
        )}
      </div>
      {model?.state === 'downloading' && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-elevated" role="progressbar" aria-label="语音模型下载进度" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
