import Utils from './utils.js';
import {
    extractNineFrameCanvases,
    encodeAnimatedGifBytes,
    parseFrameDelayInput,
} from './nineGridGif.js';

/** jokes.json 加载失败或为空时的内置题（仍走同一套点题 / 看答案 / 3 秒换题） */
/** GIF 九宫格：提交给接口的提示词前缀（与用户输入拼接，仅前端） */
const NINE_GRID_GIF_PROMPT_PREFIX =
    '一个 3×3 的九宫格，包含 9 张无缝衔接的连续序列帧，采用电影胶片条样式（无边框），展示动作描述的流畅动作过程。[主体与场景]，要求所有帧中角色保持严格一致，背景保持静态不变。人物动作描述：';

const FALLBACK_JOKES = [
    {
        question: '什么东西越洗越脏？',
        answer: '水。',
    },
    {
        question: '什么门永远关不上？',
        answer: '球门。',
    },
    {
        question: '什么海没有鱼？',
        answer: '辞海。',
    },
];

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
        const modeRaw = urlParams.get('mode');
        this.isGifMode =
            modeRaw != null && String(modeRaw).trim().toLowerCase() === 'gif';
        /** GIF 九宫格：9 张等大的帧 canvas；预览用 setTimeout 链 */
        this._nineFrames = null;
        this._ninePreviewTimer = null;
        this._ninePreviewIndex = 0;

        /** 正在轮询等待的 db 任务 id（字符串） */
        this._tasksInFlight = new Set();
        /** 同一任务只跑一条轮询，避免 RPC active 与本地提交重复 track */
        this._pollingTasks = new Set();

        /** jokes.json：纯前端冷笑话 */
        this._jokesList = [];
        this._currentJoke = null;
        this._jokeAnswerRevealed = false;
        this._jokeAfterAnswerTimer = null;
        /** 从「无进行中任务」进入「有任务」后展示笑话区，直到再次 n=0 */
        this._jokesUiSessionForTasks = false;

        void this.init();
    }

    async init() {
        this.sbClient = window.supabase.createClient(this.SUPABASE_URL, this.SUPABASE_ANON_KEY);

        await this.loadJokesLibrary();
        this.bindEvents();
        this.applyGifModeUI();
        await this.loadQuotaOnMount();
        await this.loadGalleryFromRpc();
        this.applyGifModeUI();
    }

    async loadJokesLibrary() {
        try {
            const base = new URL('.', window.location.href);
            const res = await fetch(new URL('jokes.json', base));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this._jokesList = Array.isArray(data)
                ? data.filter((x) => x && typeof x.question === 'string')
                : [];
        } catch (e) {
            console.warn('加载 jokes.json 失败:', e);
            this._jokesList = [];
        }
    }

    _effectiveJokeList() {
        return this._jokesList.length > 0 ? this._jokesList : FALLBACK_JOKES;
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

    applyGifModeUI() {
        const gifBar = document.getElementById('gifModeToolbar');
        const linkGif = document.getElementById('navLinkGifMode');
        const linkStatic = document.getElementById('navLinkStaticMode');
        const titleEl = document.getElementById('outputPageTitle');

        /** 始终基于当前页完整 URL 改 query，避免 `new URL('generate.html', base)` 在部分环境下丢参数 */
        const staticUrl = new URL(window.location.href);
        staticUrl.searchParams.delete('mode');
        if (this.invitationCode) staticUrl.searchParams.set('code', this.invitationCode);
        else staticUrl.searchParams.delete('code');

        const gifUrl = new URL(window.location.href);
        gifUrl.searchParams.set('mode', 'gif');
        if (this.invitationCode) gifUrl.searchParams.set('code', this.invitationCode);
        else gifUrl.searchParams.delete('code');

        document.body.classList.toggle('gif-mode', this.isGifMode);

        if (this.isGifMode) {
            document.title = 'GIF 九宫格';
            if (titleEl) titleEl.textContent = 'GIF 九宫格';
            if (gifBar) {
                gifBar.removeAttribute('hidden');
                gifBar.hidden = false;
            }
            if (linkGif) {
                linkGif.hidden = false;
                linkGif.removeAttribute('aria-hidden');
                linkGif.href = gifUrl.href;
                linkGif.classList.add('nav-mode-link--active');
                linkGif.setAttribute('aria-current', 'page');
            }
            if (linkStatic) {
                linkStatic.hidden = false;
                linkStatic.removeAttribute('aria-hidden');
                linkStatic.href = staticUrl.href;
                linkStatic.classList.remove('nav-mode-link--active');
                linkStatic.removeAttribute('aria-current');
            }
            const res = document.getElementById('resolution');
            const ar = document.getElementById('aspectRatio');
            if (res) {
                res.value = '1k';
                res.disabled = true;
            }
            if (ar) {
                ar.value = '1:1';
                ar.disabled = true;
            }
        } else {
            document.title = 'AI 生图 - GPT Image 2.0';
            if (titleEl) titleEl.textContent = 'Output';
            if (gifBar) {
                gifBar.setAttribute('hidden', '');
                gifBar.hidden = true;
            }
            if (linkGif) {
                linkGif.hidden = false;
                linkGif.removeAttribute('aria-hidden');
                linkGif.href = gifUrl.href;
                linkGif.classList.remove('nav-mode-link--active');
                linkGif.removeAttribute('aria-current');
            }
            if (linkStatic) {
                linkStatic.hidden = false;
                linkStatic.removeAttribute('aria-hidden');
                linkStatic.href = staticUrl.href;
                linkStatic.classList.add('nav-mode-link--active');
                linkStatic.setAttribute('aria-current', 'page');
            }
        }
    }

    /**
     * 用户输入框中的原文；GIF 模式下提交给接口时再拼接九宫格说明前缀。
     * @param {string} userPromptTrimmed
     * @returns {string}
     */
    buildSubmittedPrompt(userPromptTrimmed) {
        if (!this.isGifMode) return userPromptTrimmed;
        return NINE_GRID_GIF_PROMPT_PREFIX + userPromptTrimmed;
    }

    stopNineGridPreview() {
        if (this._ninePreviewTimer != null) {
            clearTimeout(this._ninePreviewTimer);
            this._ninePreviewTimer = null;
        }
        this._ninePreviewIndex = 0;
    }

    async startNineGridPreviewFromUrl(imageUrl) {
        if (!this.isGifMode || !imageUrl) return;
        this.stopNineGridPreview();
        const canvas = document.getElementById('nineGridPreviewCanvas');
        const imgEl = document.getElementById('resultImage');
        const exportBtn = document.getElementById('exportNineGridGifBtn');
        if (!canvas || !imgEl) return;
        try {
            const frames = await extractNineFrameCanvases(imageUrl);
            this._nineFrames = frames;
            const w = frames[0].width;
            const h = frames[0].height;
            canvas.width = w;
            canvas.height = h;
            canvas.removeAttribute('hidden');
            imgEl.classList.add('result-image--gif-preview-hidden');
            if (exportBtn) exportBtn.disabled = false;

            const input = document.getElementById('gifFrameDelayInput');
            const d0 = parseFrameDelayInput(input?.value);
            this._ninePreviewIndex = 0;
            const tick = () => {
                if (!this._nineFrames?.length || !this.isGifMode) return;
                const d = parseFrameDelayInput(document.getElementById('gifFrameDelayInput')?.value);
                const f = this._nineFrames[this._ninePreviewIndex];
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(f, 0, 0);
                this._ninePreviewIndex = (this._ninePreviewIndex + 1) % this._nineFrames.length;
                this._ninePreviewTimer = setTimeout(tick, d);
            };
            this._ninePreviewTimer = setTimeout(tick, d0);
        } catch (e) {
            console.warn(e);
            Utils.showErrorToast(e.message || '九宫格预览失败（请确认图片域名已允许 CORS）');
            this._nineFrames = null;
            if (exportBtn) exportBtn.disabled = true;
            canvas.setAttribute('hidden', '');
            imgEl.classList.remove('result-image--gif-preview-hidden');
        }
    }

    async exportNineGridGif() {
        if (!this.isGifMode) return;
        const exportBtn = document.getElementById('exportNineGridGifBtn');
        if (!this._nineFrames?.length) {
            Utils.showErrorToast('请先在当前预览生成一张图');
            return;
        }
        const delay = parseFrameDelayInput(document.getElementById('gifFrameDelayInput')?.value);
        try {
            if (exportBtn) exportBtn.disabled = true;
            const bytes = await encodeAnimatedGifBytes(this._nineFrames, delay);
            const blob = new Blob([bytes], { type: 'image/gif' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `九宫格-${Date.now()}.gif`;
            a.click();
            URL.revokeObjectURL(a.href);
            this.stopNineGridPreview();
            await this.startNineGridPreviewFromUrl(this.currentImageUrl);
        } catch (e) {
            console.error(e);
            Utils.showErrorToast('导出 GIF 失败：' + (e.message || String(e)));
        } finally {
            if (exportBtn) exportBtn.disabled = !this._nineFrames?.length;
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

        const lb = document.getElementById('imageLightbox');
        const lbClose = document.getElementById('imageLightboxClose');
        const lbBackdrop = document.getElementById('imageLightboxBackdrop');
        if (lbClose) lbClose.addEventListener('click', () => this.closeLightbox());
        if (lbBackdrop) lbBackdrop.addEventListener('click', () => this.closeLightbox());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && lb && !lb.hasAttribute('hidden')) this.closeLightbox();
        });

        const jokeQ = document.getElementById('jokeQuestionBtn');
        if (jokeQ) jokeQ.addEventListener('click', () => this.onJokeQuestionClick());

        const exportGifBtn = document.getElementById('exportNineGridGifBtn');
        if (exportGifBtn) exportGifBtn.addEventListener('click', () => void this.exportNineGridGif());

        const resultImage = document.getElementById('resultImage');
        if (resultImage) {
            resultImage.addEventListener('error', () => {
                resultImage.classList.add('result-image--placeholder');
                resultImage.src =
                    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                resultImage.alt = '';
            });
        }
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

    // 调用 create-image Edge Function（提交后不锁 Run；后台轮询；多张并发）
    async generateImage() {
        const prompt = document.getElementById('promptInput').value.trim();
        let resolution = document.getElementById('resolution').value;
        let aspectRatio = document.getElementById('aspectRatio').value;
        if (this.isGifMode) {
            resolution = '1k';
            aspectRatio = '1:1';
        }

        if (!prompt) {
            Utils.showErrorToast('请输入提示词');
            return;
        }

        const submittedPrompt = this.buildSubmittedPrompt(prompt);

        const requiredQuota = this.getRequiredQuota(resolution);
        const hasQuota = await this.checkInvitationCode(requiredQuota);
        if (!hasQuota) return;

        const outputPlaceholder = document.querySelector('.output-placeholder');
        const resultContainer = document.querySelector('.result-container');

        outputPlaceholder.style.display = 'none';
        resultContainer.classList.add('active');

        try {
            const options = {
                resolution: resolution,
                aspectRatio: aspectRatio,
                hasReference: this.uploadedFiles.length > 0,
                imageType: this.isGifMode ? 'nine_grid' : null,
            };
            const taskInfo = await this.submitGenerateTask(submittedPrompt, options);
            const id = String(taskInfo.dbTaskId);
            this._tasksInFlight.add(id);
            this.addPendingTaskCard(id, resolution, aspectRatio);
            this.updateConcurrentBanner();
            void this.syncRunButtonWithQuota();
            void this.trackTaskInBackground(id);
        } catch (err) {
            console.error('提交生图失败:', err);
            Utils.showErrorToast('提交失败：' + err.message);
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

        const body = {
            prompt: prompt,
            resolution: options.resolution,
            aspectRatio: options.aspectRatio,
            invitationCode: this.invitationCode,
            imageUrls: imageUrls,
        };
        if (options.imageType === 'nine_grid') body.imageType = 'nine_grid';

        const response = await fetch(this.SUPABASE_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify(body),
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
                resolution: data.resolution,
                aspect_ratio: data.aspect_ratio,
                started_at: data.started_at,
                image_type: data.image_type ?? null,
            },
        };
    }

    async loadGalleryFromRpc() {
        if (!this.invitationCode || !this.sbClient) return;
        this._tasksInFlight.clear();
        const { data, error } = await this.sbClient.rpc('list_generation_gallery', {
            p_code: this.invitationCode,
        });
        if (error || !data || !data.ok) return;
        const activeRow = document.getElementById('galleryActiveRow');
        const doneGrid = document.getElementById('galleryCompletedGrid');
        if (!activeRow || !doneGrid) return;
        activeRow.innerHTML = '';
        doneGrid.innerHTML = '';
        const act = Array.isArray(data.active) ? data.active : [];
        const done = Array.isArray(data.completed) ? data.completed : [];
        const isNineGridRow = (row) =>
            row && String(row.image_type || '').toLowerCase() === 'nine_grid';
        for (const a of act) {
            if (!a?.id) continue;
            if (isNineGridRow(a)) continue;
            this.addPendingTaskCard(String(a.id), a.resolution || '—', a.aspect_ratio || '—');
            this._tasksInFlight.add(String(a.id));
            void this.trackTaskInBackground(String(a.id));
        }
        for (const c of done) {
            if (!c?.image_url) continue;
            if (isNineGridRow(c)) continue;
            this.prependCompletedCard(c, false);
        }
        this.trimCompletedCardsTo(30);
        this.updateConcurrentBanner();
    }

    updateConcurrentBanner() {
        const el = document.getElementById('outputStatusBanner');
        const n = this._tasksInFlight.size;
        if (el) {
            if (n <= 0) {
                el.hidden = true;
                el.textContent = '';
            } else {
                el.hidden = false;
                el.textContent = `当前有 ${n} 个任务正在生成中`;
            }
        }
        this.syncTasksJokesPanel();
    }

    /** n>0 时显示笑话区；进入有任务瞬间抽题；点击见答案后 3 秒换下一题（完全随机） */
    syncTasksJokesPanel() {
        const panel = document.getElementById('outputTasksJokes');
        const qBtn = document.getElementById('jokeQuestionBtn');
        const ans = document.getElementById('jokeAnswerText');
        if (!panel || !qBtn || !ans) return;

        const n = this._tasksInFlight.size;
        if (n <= 0) {
            this._clearJokeAfterAnswerTimer();
            this._jokeAnswerRevealed = false;
            this._jokesUiSessionForTasks = false;
            this._currentJoke = null;
            panel.setAttribute('hidden', '');
            qBtn.textContent = '';
            qBtn.disabled = false;
            qBtn.setAttribute('aria-expanded', 'false');
            ans.textContent = '';
            ans.hidden = true;
            return;
        }

        panel.removeAttribute('hidden');
        if (!this._jokesUiSessionForTasks) {
            this._jokesUiSessionForTasks = true;
            this._resetJokeRound();
        }
    }

    _clearJokeAfterAnswerTimer() {
        if (this._jokeAfterAnswerTimer != null) {
            clearTimeout(this._jokeAfterAnswerTimer);
            this._jokeAfterAnswerTimer = null;
        }
    }

    _resetJokeRound() {
        this._jokeAnswerRevealed = false;
        this._clearJokeAfterAnswerTimer();
        const ans = document.getElementById('jokeAnswerText');
        const qBtn = document.getElementById('jokeQuestionBtn');
        if (ans) {
            ans.textContent = '';
            ans.hidden = true;
        }
        if (qBtn) {
            qBtn.setAttribute('aria-expanded', 'false');
            qBtn.disabled = false;
        }
        this._pickRandomQuestionToUI();
    }

    _pickRandomQuestionToUI() {
        const qBtn = document.getElementById('jokeQuestionBtn');
        if (!qBtn) return;
        const list = this._effectiveJokeList();
        if (!list.length) {
            this._currentJoke = null;
            qBtn.textContent = '暂无题目';
            qBtn.disabled = true;
            return;
        }
        const j = list[Math.floor(Math.random() * list.length)];
        this._currentJoke = j;
        qBtn.textContent = j.question;
        qBtn.disabled = false;
    }

    onJokeQuestionClick() {
        if (this._jokeAnswerRevealed) return;
        if (this._tasksInFlight.size <= 0) return;
        const joke = this._currentJoke;
        if (!joke || typeof joke.answer !== 'string') return;

        this._jokeAnswerRevealed = true;
        const ans = document.getElementById('jokeAnswerText');
        const qBtn = document.getElementById('jokeQuestionBtn');
        if (ans) {
            ans.textContent = joke.answer;
            ans.hidden = false;
        }
        if (qBtn) {
            qBtn.setAttribute('aria-expanded', 'true');
            qBtn.disabled = true;
        }

        this._clearJokeAfterAnswerTimer();
        this._jokeAfterAnswerTimer = setTimeout(() => {
            this._jokeAfterAnswerTimer = null;
            if (this._tasksInFlight.size <= 0) return;
            this._jokeAnswerRevealed = false;
            this._pickRandomQuestionToUI();
            const ans2 = document.getElementById('jokeAnswerText');
            const qBtn2 = document.getElementById('jokeQuestionBtn');
            if (ans2) {
                ans2.textContent = '';
                ans2.hidden = true;
            }
            if (qBtn2) {
                qBtn2.setAttribute('aria-expanded', 'false');
                qBtn2.disabled = this._effectiveJokeList().length === 0;
            }
        }, 3000);
    }

    async syncRunButtonWithQuota() {
        const runBtn = document.getElementById('runButton');
        const quotaEl = document.getElementById('quotaCount');
        if (!runBtn || !this.invitationCode) return;
        const row = await this.fetchInvitationQuotaRow();
        if (row.error || !row.data) return;
        const d = row.data;
        const remaining = d.generation_quota - d.used_count;
        if (quotaEl) quotaEl.textContent = remaining;
        runBtn.disabled = !d.is_active || remaining <= 0;
    }

    addPendingTaskCard(dbTaskId, resolution, aspectRatio) {
        const row = document.getElementById('galleryActiveRow');
        if (!row || row.querySelector(`[data-task-id="${dbTaskId}"]`)) return;
        const el = document.createElement('div');
        el.className = 'gallery-card gallery-card--pending';
        el.dataset.taskId = dbTaskId;
        el.innerHTML = `
            <div class="gallery-card-pending-spin" aria-hidden="true"></div>
            <div class="gallery-card-meta">生成中…</div>
            <div class="gallery-card-sub">${this.escapeHtml(String(resolution))} · ${this.escapeHtml(String(aspectRatio))}</div>
            <div class="gallery-card-progress"><span class="pending-progress-num">—</span></div>
        `;
        row.insertAdjacentElement('afterbegin', el);
    }

    escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    updatePendingTaskProgress(dbTaskId, progress) {
        const row = document.getElementById('galleryActiveRow');
        if (!row) return;
        const card = row.querySelector(`[data-task-id="${dbTaskId}"]`);
        if (!card) return;
        const span = card.querySelector('.pending-progress-num');
        if (!span) return;
        if (progress == null || Number.isNaN(Number(progress))) span.textContent = '—';
        else span.textContent = `${Math.round(Number(progress))}%`;
    }

    removePendingTaskCard(dbTaskId) {
        const row = document.getElementById('galleryActiveRow');
        if (!row) return;
        const card = row.querySelector(`[data-task-id="${dbTaskId}"]`);
        if (card) card.remove();
    }

    formatTaskTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    prependCompletedCard(item, trim = true) {
        const grid = document.getElementById('galleryCompletedGrid');
        if (!grid || !item?.image_url) return;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'gallery-card gallery-card--done';
        el.dataset.cardType = 'completed';
        el.dataset.imageUrl = item.image_url;
        const t = this.formatTaskTime(item.started_at);
        const meta = [item.resolution, item.aspect_ratio].filter(Boolean).join(' · ');
        const img = document.createElement('img');
        img.className = 'gallery-card-thumb';
        img.src = item.image_url;
        img.alt = '';
        img.loading = 'lazy';
        const cap = document.createElement('div');
        cap.className = 'gallery-card-caption';
        const sp1 = document.createElement('span');
        sp1.className = 'gallery-card-time';
        sp1.textContent = t || '—';
        const sp2 = document.createElement('span');
        sp2.className = 'gallery-card-res';
        sp2.textContent = meta || '';
        cap.append(sp1, sp2);
        el.append(img, cap);
        el.addEventListener('click', () => this.openLightbox(item.image_url));
        grid.insertAdjacentElement('afterbegin', el);
        if (trim) this.trimCompletedCardsTo(30);
    }

    trimCompletedCardsTo(max) {
        const grid = document.getElementById('galleryCompletedGrid');
        if (!grid) return;
        while (grid.children.length > max) {
            grid.removeChild(grid.lastElementChild);
        }
    }

    async trackTaskInBackground(dbTaskId) {
        if (this._pollingTasks.has(dbTaskId)) return;
        this._pollingTasks.add(dbTaskId);
        const intervalMs = 2500;
        const maxAttempts = Math.ceil((22 * 60 * 1000) / intervalMs);
        try {
            for (let i = 0; i < maxAttempts; i++) {
                const row = await this.fetchGenerationTaskRow(dbTaskId);
                if (row.error) {
                    this._tasksInFlight.delete(dbTaskId);
                    this.removePendingTaskCard(dbTaskId);
                    this.updateConcurrentBanner();
                    Utils.showErrorToast(row.message || '查询任务失败');
                    return;
                }
                const d = row.data;
                if (d.progress != null) this.updatePendingTaskProgress(dbTaskId, d.progress);
                if (d.status === 'completed' && d.image_url) {
                    await this.onTaskComplete(dbTaskId, d);
                    return;
                }
                if (d.status === 'failed') {
                    this._tasksInFlight.delete(dbTaskId);
                    this.removePendingTaskCard(dbTaskId);
                    this.updateConcurrentBanner();
                    Utils.showErrorToast(d.error_message || '生图任务失败');
                    return;
                }
                await new Promise((r) => setTimeout(r, intervalMs));
            }
            this._tasksInFlight.delete(dbTaskId);
            this.removePendingTaskCard(dbTaskId);
            this.updateConcurrentBanner();
            Utils.showErrorToast('生图超时，请稍后刷新页面查看');
        } finally {
            this._pollingTasks.delete(dbTaskId);
        }
    }

    async onTaskComplete(dbTaskId, d) {
        const imageUrl = d.image_url;
        if (!imageUrl) return;
        this._tasksInFlight.delete(dbTaskId);
        this.removePendingTaskCard(dbTaskId);
        this.updateConcurrentBanner();

        await this.refreshQuotaDisplay();

        const resultImage = document.getElementById('resultImage');
        const loadingOverlay = document.querySelector('.loading-overlay');
        const resultWrap = document.querySelector('.result-image-wrapper');
        const viewOriginalBtn = document.getElementById('viewOriginalBtn');
        const downloadBtn = document.getElementById('downloadBtn');
        const nineCanvas = document.getElementById('nineGridPreviewCanvas');

        this.stopNineGridPreview();
        if (nineCanvas) nineCanvas.setAttribute('hidden', '');
        if (resultImage) resultImage.classList.remove('result-image--gif-preview-hidden');

        if (resultImage) {
            resultImage.classList.remove('result-image--placeholder');
            resultImage.alt = '生成结果';
            resultImage.src = imageUrl;
        }
        this.currentImageUrl = imageUrl;
        if (loadingOverlay) loadingOverlay.classList.remove('active');
        if (resultWrap) resultWrap.classList.remove('is-generating');
        if (viewOriginalBtn) viewOriginalBtn.disabled = false;
        if (downloadBtn) downloadBtn.disabled = false;

        const isNineGridTask =
            String(d.image_type || '').toLowerCase() === 'nine_grid';
        if (this.isGifMode) {
            void this.startNineGridPreviewFromUrl(imageUrl);
        } else if (!isNineGridTask) {
            this.prependCompletedCard(
                {
                    id: dbTaskId,
                    image_url: imageUrl,
                    resolution: d.resolution,
                    aspect_ratio: d.aspect_ratio,
                    started_at: d.started_at,
                },
                true,
            );
        }
    }

    openLightbox(url) {
        const box = document.getElementById('imageLightbox');
        const img = document.getElementById('imageLightboxImg');
        if (!box || !img) return;
        img.src = url;
        box.removeAttribute('hidden');
        box.setAttribute('aria-hidden', 'false');
    }

    closeLightbox() {
        const box = document.getElementById('imageLightbox');
        const img = document.getElementById('imageLightboxImg');
        if (box) {
            box.setAttribute('hidden', '');
            box.setAttribute('aria-hidden', 'true');
        }
        if (img) img.src = '';
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