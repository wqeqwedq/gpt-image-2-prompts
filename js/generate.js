import Utils from './utils.js';

class GeneratePage {
    constructor() {
        this.sbClient = null;
        this.uploadedFiles = [];
        this.currentPreviewIndex = 0;
        this.currentImageUrl = null;
        
        // Supabase 配置（从 generate1.html 获取）
        this.SUPABASE_URL = 'https://vqubaohredxnfsbgstur.supabase.co';
        this.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdWJhb2hyZWR4bmZzYmdzdHVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczOTIwMTQsImV4cCI6MjA5Mjk2ODAxNH0.RZf20V3O6-e-EmHXTdKByMQOS5pKI8jS4MlDTg7fHt0';
        
        // Supabase Edge Function URL
        this.SUPABASE_FUNCTION_URL = 'https://vqubaohredxnfsbgstur.supabase.co/functions/v1/create-image';
        
        // 从 URL 参数获取邀请码，如果没有则从 localStorage 获取
        const urlParams = new URLSearchParams(window.location.search);
        this.invitationCode = urlParams.get('code') || localStorage.getItem('verifiedInvitationCode');
        /** @type {ReturnType<typeof setInterval> | null} */
        this._simProgressTimer = null;

        void this.init();
    }

    async init() {
        this.sbClient = window.supabase.createClient(this.SUPABASE_URL, this.SUPABASE_ANON_KEY);

        this.bindEvents();
        await this.loadQuotaOnMount();
    }

    /** 进入页面立即拉取额度并更新导航栏；无邀请码则提示并回首页 */
    async loadQuotaOnMount() {
        const quotaCount = document.getElementById('quotaCount');
        const runButton = document.getElementById('runButton');

        if (!quotaCount || !runButton) return;

        if (!this.invitationCode) {
            quotaCount.textContent = '0';
            runButton.disabled = true;
            Utils.showErrorToast('未找到邀请码，正在跳转到首页...');
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 2000);
            return;
        }

        quotaCount.textContent = '…';

        try {
            const row = await this.fetchInvitationQuotaRow();
            if (row.error || !row.data) {
                quotaCount.textContent = '0';
                runButton.disabled = true;
                Utils.showErrorToast('邀请码无效');
                return;
            }

            const data = row.data;
            if (!data.is_active) {
                quotaCount.textContent = '0';
                runButton.disabled = true;
                Utils.showErrorToast('邀请码已被禁用');
                return;
            }

            const remaining = data.generation_quota - data.used_count;
            quotaCount.textContent = remaining;
            runButton.disabled = remaining <= 0;
        } catch (err) {
            console.error('加载额度失败:', err);
            quotaCount.textContent = '—';
            runButton.disabled = true;
        }
    }

    bindEvents() {
        // 运行按钮
        const runBtn = document.getElementById('runButton');
        if (runBtn) {
            runBtn.addEventListener('click', () => this.generateImage());
        }

        // 上传区域
        const uploadArea = document.getElementById('uploadArea');
        const uploadInput = document.getElementById('uploadInput');
        if (uploadArea && uploadInput) {
            uploadArea.addEventListener('click', (e) => {
                // 点击箭头或删除按钮时不触发文件选择
                if (e.target.closest('.preview-arrow') || e.target.closest('.preview-delete')) return;
                uploadInput.click();
            });
            uploadInput.addEventListener('change', (e) => this.handleFileUpload(e));
        }

        // 预览导航
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const deleteBtn = document.getElementById('deleteBtn');
        
        if (prevBtn) prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.previousImage();
        });
        if (nextBtn) nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.nextImage();
        });
        if (deleteBtn) deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteCurrentImage();
        });

        const downloadBtn = document.getElementById('downloadBtn');
        const viewOriginalBtn = document.getElementById('viewOriginalBtn');

        if (downloadBtn) downloadBtn.addEventListener('click', () => this.downloadResult());
        if (viewOriginalBtn) viewOriginalBtn.addEventListener('click', () => this.viewOriginal());
    }

    /** 与 Edge create-image 一致：1k=1，2k=2，4k=3 */
    getRequiredQuota(resolution) {
        const r = (resolution || '1k').toLowerCase().trim();
        if (r === '4k') return 3;
        if (r === '2k') return 2;
        return 1;
    }

    // 验证邀请码并获取额度（remaining 需 >= requiredQuota）
    async checkInvitationCode(requiredQuota = 1) {
        const quotaCount = document.getElementById('quotaCount');
        const runButton = document.getElementById('runButton');
        
        if (!this.invitationCode) {
            // 既没有 URL 参数也没有 localStorage，重定向到首页
            Utils.showErrorToast('未找到邀请码，正在跳转到首页...');
            quotaCount.textContent = '0';
            runButton.disabled = true;
            
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 2000);
            
            return false;
        }

        try {
            const row = await this.fetchInvitationQuotaRow();
            if (row.error || !row.data) {
                Utils.showErrorToast('邀请码无效');
                quotaCount.textContent = '0';
                runButton.disabled = true;
                return false;
            }

            const data = row.data;
            if (!data.is_active) {
                Utils.showErrorToast('邀请码已被禁用');
                quotaCount.textContent = '0';
                runButton.disabled = true;
                return false;
            }

            const remaining = data.generation_quota - data.used_count;
            quotaCount.textContent = remaining;

            if (remaining < requiredQuota) {
                Utils.showErrorToast(
                    remaining <= 0
                        ? '生图额度已用完'
                        : `额度不足：本次需要 ${requiredQuota} 点，当前剩余 ${remaining}`
                );
                if (remaining <= 0) runButton.disabled = true;
                return false;
            }

            return true;

        } catch (err) {
            console.error('验证邀请码失败:', err);
            Utils.showErrorToast('验证邀请码失败');
            quotaCount.textContent = '0';
            runButton.disabled = true;
            return false;
        }
    }

    handleFileUpload(event) {
        const files = Array.from(event.target.files);
        const remaining = 16 - this.uploadedFiles.length;
        
        if (remaining <= 0) {
            Utils.showErrorToast('最多上传 16 张图片');
            return;
        }
        
        const filesToAdd = files.slice(0, remaining);
        
        filesToAdd.forEach(file => {
            if (file.size > 10 * 1024 * 1024) {
                Utils.showErrorToast(`图片 ${file.name} 超过 10MB 限制`);
                return;
            }
            
            const reader = new FileReader();
            reader.onload = (e) => {
                this.uploadedFiles.push({
                    file: file,
                    url: e.target.result
                });
                this.updatePreview();
            };
            reader.readAsDataURL(file);
        });

        event.target.value = '';
    }

    updatePreview() {
        const previewContainer = document.getElementById('previewContainer');
        const uploadPlaceholder = document.getElementById('uploadPlaceholder');
        const uploadArea = document.getElementById('uploadArea');
        const previewCounter = document.getElementById('previewCounter');
        const previewImage = document.getElementById('previewImage');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');

        if (this.uploadedFiles.length > 0) {
            previewContainer.classList.add('active');
            uploadPlaceholder.style.display = 'none';
            uploadArea.classList.add('has-file');
            
            previewImage.src = this.uploadedFiles[this.currentPreviewIndex].url;
            previewCounter.textContent = `${this.currentPreviewIndex + 1} / ${this.uploadedFiles.length}`;
            
            prevBtn.disabled = this.currentPreviewIndex === 0;
            nextBtn.disabled = this.currentPreviewIndex === this.uploadedFiles.length - 1;
        } else {
            previewContainer.classList.remove('active');
            uploadPlaceholder.style.display = 'flex';
            uploadArea.classList.remove('has-file');
        }
    }

    previousImage() {
        if (this.currentPreviewIndex > 0) {
            this.currentPreviewIndex--;
            this.updatePreview();
        }
    }

    nextImage() {
        if (this.currentPreviewIndex < this.uploadedFiles.length - 1) {
            this.currentPreviewIndex++;
            this.updatePreview();
        }
    }

    deleteCurrentImage() {
        this.uploadedFiles.splice(this.currentPreviewIndex, 1);
        if (this.currentPreviewIndex >= this.uploadedFiles.length) {
            this.currentPreviewIndex = Math.max(0, this.uploadedFiles.length - 1);
        }
        this.updatePreview();
    }

    // 调用 create-image Edge Function
    async generateImage() {
        const prompt = document.getElementById('promptInput').value.trim();
        const resolution = document.getElementById('resolution').value;
        const aspectRatio = document.getElementById('aspectRatio').value;
        
        if (!prompt) {
            Utils.showErrorToast('请输入提示词');
            return;
        }

        const requiredQuota = this.getRequiredQuota(resolution);
        const hasQuota = await this.checkInvitationCode(requiredQuota);
        if (!hasQuota) return;

        const runBtn = document.getElementById('runButton');
        const resultContainer = document.querySelector('.result-container');
        const resultImageWrapper = document.querySelector('.result-image-wrapper');
        const outputPlaceholder = document.querySelector('.output-placeholder');
        const loadingOverlay = document.querySelector('.loading-overlay');
        const viewOriginalBtn = document.getElementById('viewOriginalBtn');
        const downloadBtn = document.getElementById('downloadBtn');

        runBtn.disabled = true;
        outputPlaceholder.style.display = 'none';
        resultContainer.classList.add('active');
        if (resultImageWrapper) resultImageWrapper.classList.add('is-generating');
        loadingOverlay.classList.add('active');
        if (viewOriginalBtn) viewOriginalBtn.disabled = true;
        if (downloadBtn) downloadBtn.disabled = true;

        this.startSimulatedProgress();

        try {
            // 收集参数
            const options = {
                resolution: resolution,
                aspectRatio: aspectRatio,
                hasReference: this.uploadedFiles.length > 0
            };

            // 1. 提交生图任务（调用 Edge Function）
            const taskInfo = await this.submitGenerateTask(prompt, options);
            console.log('任务已提交:', taskInfo);

            const imageUrl = await this.waitForTaskCompletion(taskInfo.dbTaskId);
            this.currentImageUrl = imageUrl;

            await this.refreshQuotaDisplay();

            this.stopSimulatedProgress();
            this.setSimulatedProgressBar(100);
            await new Promise((r) => setTimeout(r, 200));

            const resultImage = document.getElementById('resultImage');
            resultImage.src = imageUrl;

            loadingOverlay.classList.remove('active');
            if (resultImageWrapper) resultImageWrapper.classList.remove('is-generating');
            resultContainer.classList.add('active');
            if (viewOriginalBtn) viewOriginalBtn.disabled = false;
            if (downloadBtn) downloadBtn.disabled = false;

        } catch (err) {
            console.error('生图失败:', err);
            Utils.showErrorToast('生图失败：' + err.message);

            this.stopSimulatedProgress();
            loadingOverlay.classList.remove('active');
            const wrap = document.querySelector('.result-image-wrapper');
            if (wrap) wrap.classList.remove('is-generating');
            resultContainer.classList.remove('active');
            outputPlaceholder.style.display = 'flex';
            if (viewOriginalBtn) viewOriginalBtn.disabled = true;
            if (downloadBtn) downloadBtn.disabled = true;
        } finally {
            runBtn.disabled = false;
        }
    }

    // 提交生图任务到 Edge Function
    async submitGenerateTask(prompt, options) {
        // 准备参考图URL（如果有）
        let imageUrls = [];
        if (this.uploadedFiles.length > 0) {
            for (const item of this.uploadedFiles) {
                imageUrls.push(item.url);
            }
        }

        const response = await fetch(this.SUPABASE_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                prompt: prompt,
                resolution: options.resolution,
                aspectRatio: options.aspectRatio,
                invitationCode: this.invitationCode,
                imageUrls: imageUrls
            })
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok || !result.success) {
            throw new Error(result.error || `提交生图任务失败 HTTP ${response.status}`);
        }

        if (result.remainingQuota !== undefined) {
            const quotaCount = document.getElementById('quotaCount');
            quotaCount.textContent = result.remainingQuota;
        }

        // 返回任务 ID，用于轮询
        return {
            dbTaskId: result.dbTaskId,
            message: result.message
        };
    }

    async refreshQuotaDisplay() {
        if (!this.invitationCode) return;
        const el = document.getElementById('quotaCount');
        const runButton = document.getElementById('runButton');
        try {
            const row = await this.fetchInvitationQuotaRow();
            if (!row.error && row.data && el) {
                const data = row.data;
                const remaining = data.generation_quota - data.used_count;
                el.textContent = remaining;
                if (runButton) runButton.disabled = !data.is_active || remaining <= 0;
            }
        } catch (_) { /* ignore */ }
    }

    /** RPC：get_invitation_code_quota — 仅返回当前邀请码一行额度字段 */
    async fetchInvitationQuotaRow() {
        if (!this.invitationCode) return { error: true };
        const { data, error } = await this.sbClient.rpc('get_invitation_code_quota', {
            p_code: this.invitationCode,
        });
        if (error) return { error: true, message: error.message };
        if (!data || !data.ok) return { error: true, message: data?.error };
        return {
            data: {
                generation_quota: data.generation_quota,
                used_count: data.used_count,
                is_active: data.is_active,
            },
        };
    }

    /** RPC：get_generation_task_for_invitation — 任务须属于当前页邀请码 */
    async fetchGenerationTaskRow(dbTaskId) {
        const { data, error } = await this.sbClient.rpc('get_generation_task_for_invitation', {
            p_task_id: dbTaskId,
            p_invitation_code: this.invitationCode,
        });
        if (error) return { error: true, message: error.message };
        if (!data || !data.ok) return { error: true, message: data?.error };
        return {
            data: {
                status: data.status,
                image_url: data.image_url,
                error_message: data.error_message,
                progress: data.progress,
            },
        };
    }

    /**
     * 轮询 RPC 等待任务完成（anon 已无 generation_tasks SELECT，Realtime 不可用）。
     */
    async waitForTaskCompletion(dbTaskId) {
        const intervalMs = 2500;
        const maxAttempts = Math.ceil((22 * 60 * 1000) / intervalMs);

        for (let i = 0; i < maxAttempts; i++) {
            const row = await this.fetchGenerationTaskRow(dbTaskId);
            if (row.error) throw new Error('查询任务状态失败');

            const d = row.data;

            if (d.status === 'completed') {
                if (!d.image_url) throw new Error('任务已完成但未找到图片URL');
                return d.image_url;
            }
            if (d.status === 'failed') {
                throw new Error(d.error_message || '生图任务失败');
            }

            await new Promise((r) => setTimeout(r, intervalMs));
        }
        throw new Error('生图超时，请稍后到历史记录中查看结果');
    }

    /** 前端模拟：30 秒内从 0% 线性到 99%，之后保持 99% 直到 stop（出图） */
    static SIM_PROGRESS_DURATION_MS = 30000;

    stopSimulatedProgress() {
        if (this._simProgressTimer != null) {
            clearInterval(this._simProgressTimer);
            this._simProgressTimer = null;
        }
        this._simProgressStartMs = null;
    }

    startSimulatedProgress() {
        this.stopSimulatedProgress();
        this._simProgressStartMs = Date.now();
        const tick = () => {
            const elapsed = Date.now() - this._simProgressStartMs;
            const raw = (elapsed / GeneratePage.SIM_PROGRESS_DURATION_MS) * 99;
            const p = Math.min(99, raw);
            this.setSimulatedProgressBar(p);
        };
        tick();
        this._simProgressTimer = setInterval(tick, 100);
    }

    /**
     * @param {number} p 0–100，可带小数；条与文案仅由此驱动（不读服务端 progress）
     */
    setSimulatedProgressBar(p) {
        const track = document.getElementById('loadingProgressTrack');
        const fill = document.getElementById('loadingProgressFill');
        const valueEl = document.getElementById('loadingProgressValue');
        const loadingText = document.querySelector('.loading-overlay .loading-text');
        const loadingHint = document.querySelector('.loading-overlay .loading-hint');

        const clamped = Math.max(0, Math.min(100, Number(p)));
        const display = Math.round(clamped);

        if (track && fill && valueEl) {
            track.classList.remove('indeterminate');
            fill.style.width = `${clamped}%`;
            valueEl.textContent = `${display}%`;
        }

        if (loadingText) {
            if (display < 8) loadingText.textContent = '正在提交并排队…';
            else if (display < 99) loadingText.textContent = '正在生成图片';
            else if (display < 100) loadingText.textContent = '即将完成…';
            else loadingText.textContent = '已完成';
        }
        if (loadingHint) {
            loadingHint.textContent =
                display >= 100
                    ? '正在显示结果'
                    : '进度为预估时间，实际以服务端为准；请稍候';
        }
    }

    async downloadResult() {
        const url = this.currentImageUrl || document.getElementById('resultImage')?.src;
        if (!url) return;
        const ok = await Utils.downloadImage(url, `ai-generated-${Date.now()}.jpg`);
        if (!ok) {
            Utils.showErrorToast(
                '无法直接下载（图片域名未允许跨域）。请点「查看原图」后在浏览器里右键「图片另存为」'
            );
        }
    }

    viewOriginal() {
        if (this.currentImageUrl) {
            window.open(this.currentImageUrl, '_blank');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new GeneratePage();
});