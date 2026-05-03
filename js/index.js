import Utils from './utils.js';

class IndexPage {
    constructor() {
        this.userIP = null;
        this.currentCategory = 'all';
        this.images = [];
        this.filteredImages = [];
        this.sbClient = null;
        this._invitationEventsBound = false;
        this._mainEventsBound = false;

        // Supabase 配置（从 index1.html 获取）
        this.SUPABASE_URL = 'https://vqubaohredxnfsbgstur.supabase.co';
        this.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdWJhb2hyZWR4bmZzYmdzdHVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczOTIwMTQsImV4cCI6MjA5Mjk2ODAxNH0.RZf20V3O6-e-EmHXTdKByMQOS5pKI8jS4MlDTg7fHt0';
        
        this.init();
    }

    async init() {
        this.userIP = await Utils.fetchUserIP();
        console.log('用户 IP:', this.userIP);
        
        // 先检查邀请码验证状态
        this.checkInvitation();
    }

    async initializeAppAfterVerification() {
        // 初始化 Supabase 客户端
        try {
            this.sbClient = window.supabase.createClient(this.SUPABASE_URL, this.SUPABASE_ANON_KEY);
            console.log('Supabase 客户端初始化成功');
        } catch (err) {
            console.error('Supabase 初始化失败:', err);
            return;
        }
        
        if (!this._mainEventsBound) {
            this.bindEvents();
            this._mainEventsBound = true;
        }
        if (this.images.length === 0) {
            this.loadImages();
        }
    }

    bindEvents() {
        // 搜索输入
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }

        // 模态框关闭
        const modalClose = document.querySelector('.modal-close');
        if (modalClose) {
            modalClose.addEventListener('click', () => this.closeModal());
        }

        // 图片放大关闭
        const zoomOverlay = document.getElementById('imageZoomOverlay');
        if (zoomOverlay) {
            zoomOverlay.addEventListener('click', (e) => {
                if (e.target === zoomOverlay) {
                    this.closeZoom();
                }
            });
        }

        const zoomClose = document.querySelector('.zoom-close');
        if (zoomClose) {
            zoomClose.addEventListener('click', () => this.closeZoom());
        }

        // AI生图入口按钮
        const aiBtn = document.getElementById('aiGenerateBtn');
        if (aiBtn) {
            aiBtn.addEventListener('click', () => this.gotoGeneratePage());
        }

        const changeInviteBtn = document.getElementById('changeInviteBtn');
        if (changeInviteBtn) {
            changeInviteBtn.addEventListener('click', () => this.showInvitationOverlayForReentry());
        }
    }

    checkInvitation() {
        this.ensureInvitationEventsBound();
        const code = localStorage.getItem('verifiedInvitationCode');
        const overlay = document.getElementById('invitationOverlay');
        const mainContainer = document.querySelector('.container');
        
        if (code && overlay) {
            overlay.classList.add('hidden');
            if (mainContainer) {
                mainContainer.style.display = 'flex';
            }
            setTimeout(() => {
                this.initializeAppAfterVerification();
            }, 100);
        }
    }

    /** 含「本地已有邀请码直进首页」场景，保证遮罩上的验证按钮始终可用且只绑定一次 */
    ensureInvitationEventsBound() {
        if (this._invitationEventsBound) return;
        this._invitationEventsBound = true;
        const invitationBtn = document.getElementById('invitationBtn');
        const invitationInput = document.getElementById('invitationInput');

        if (invitationBtn) {
            invitationBtn.addEventListener('click', () => this.verifyInvitation());
        }

        if (invitationInput) {
            invitationInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    this.verifyInvitation();
                }
            });
        }
    }

    /** 不清除 localStorage；二次确认后显示邀请码层并预填当前码 */
    showInvitationOverlayForReentry() {
        const msg =
            '返回邀请码界面后，您可以查看或修改邀请码（不会清除已保存的邀请码），并将关闭当前弹窗与清空搜索。是否继续？';
        if (!window.confirm(msg)) return;

        this.closeModal();
        this.closeZoom();

        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.value = '';
        }
        this.filterImages();

        const input = document.getElementById('invitationInput');
        const errorEl = document.getElementById('invitationError');
        const btn = document.getElementById('invitationBtn');
        const overlay = document.getElementById('invitationOverlay');
        const mainContainer = document.querySelector('.container');

        const saved = localStorage.getItem('verifiedInvitationCode') || '';
        if (input) {
            input.value = saved;
            input.disabled = false;
        }
        if (errorEl) errorEl.textContent = '';
        if (btn) {
            btn.disabled = false;
            btn.textContent = '验证邀请码';
        }
        if (overlay) overlay.classList.remove('hidden');
        if (mainContainer) mainContainer.style.display = 'none';
    }

    async verifyInvitation() {
        const input = document.getElementById('invitationInput');
        const errorEl = document.getElementById('invitationError');
        const btn = document.getElementById('invitationBtn');
        const overlay = document.getElementById('invitationOverlay');
        const mainContainer = document.querySelector('.container');
        
        const code = input.value.trim();
        
        if (!code) {
            errorEl.textContent = '请输入邀请码';
            return;
        }

        btn.disabled = true;
        btn.textContent = '验证中...';
        errorEl.textContent = '';

        try {
            // 使用 Supabase RPC 函数验证邀请码
            const tempClient = window.supabase.createClient(this.SUPABASE_URL, this.SUPABASE_ANON_KEY);
            
            const { data, error } = await tempClient
                .rpc('verify_invitation_code', { 
                    code_to_check: String(code),
                    client_ip: String(this.userIP || 'unknown'),
                });

            if (error) {
                console.error('verify_invitation_code RPC 错误:', error.code, error.message, error.details);
                throw new Error(
                    error.message ||
                    error.details ||
                    '验证服务暂时不可用，请稍后重试'
                );
            }

            if (data && data.rate_limited) {
                throw new Error(`尝试次数过多，请在 ${data.reset_in_minutes || 60} 分钟后再试`);
            }

            if (!data || !data.valid) {
                throw new Error(data?.message || '邀请码无效或已失效');
            }

            // 验证成功
            localStorage.setItem('verifiedInvitationCode', code);
            localStorage.setItem('verifiedAt', new Date().toISOString());
            overlay.classList.add('hidden');
            if (mainContainer) {
                mainContainer.style.display = 'flex';
            }
            
            setTimeout(() => {
                this.initializeAppAfterVerification();
            }, 100);
            
        } catch (err) {
            errorEl.textContent = err.message;
            btn.disabled = false;
            btn.textContent = '验证邀请码';
            
            if (err.message.includes('尝试次数过多')) {
                input.disabled = true;
                btn.disabled = true;
                setTimeout(() => {
                    input.disabled = false;
                    btn.disabled = false;
                    errorEl.textContent = '您可以重新尝试了';
                }, 60000);
            }
        }
    }

    gotoGeneratePage() {
        const code = localStorage.getItem('verifiedInvitationCode');
        if (!code) {
            alert('请先输入邀请码');
            return;
        }
        // 必须用 generate.html；相对路径基于当前页 URL 解析，避免在 /generate 等错误路径下跳错
        const u = new URL('./generate.html', window.location.href);
        u.searchParams.set('code', code);
        window.location.href = u.href;
    }

    loadImages() {
        const categoriesEl = document.querySelector('.categories');
        const imageGridEl = document.querySelector('.image-grid');
        
        categoriesEl.innerHTML = '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>';
        imageGridEl.innerHTML = '<div class="loading"><div class="spinner"></div><span>加载中...</span></div>';

        this.sbClient
            .from('gpt_image_prompts')
            .select('id,title,category,prompt,cdn_image,cdn_images')
            .order('id', { ascending: true })
            .then(({ data, error }) => {
                if (error) {
                    throw error;
                }

                if (!data || data.length === 0) {
                    throw new Error('没有找到数据');
                }

                this.images = data;
                this.filteredImages = [...this.images];
                
                console.log(`成功加载 ${data.length} 条数据`);
                
                this.renderCategories();
                this.renderImages();
                this.updateStats();
            })
            .catch((err) => {
                console.error('加载数据失败:', err);
                const errorMsg = err.message || '未知错误';
                
                categoriesEl.innerHTML = `
                    <div class="error-state">
                        <div class="error-state-icon">❌</div>
                        <div class="error-state-text">加载失败</div>
                        <div class="error-state-details">${errorMsg}</div>
                        <button class="retry-btn" onclick="new IndexPage().loadImages()">重试</button>
                    </div>
                `;
                
                imageGridEl.innerHTML = `
                    <div class="error-state">
                        <div class="error-state-icon">❌</div>
                        <div class="error-state-text">加载失败</div>
                        <div class="error-state-details">${errorMsg}</div>
                        <button class="retry-btn" onclick="new IndexPage().loadImages()">重试</button>
                    </div>
                `;
            });
    }

    cleanCategoryName(cat) {
        if (cat === 'all' || cat === '全部案例') return 'all';
        
        const chineseMatch = cat.match(/[\u4e00-\u9fa5]+/g);
        if (chineseMatch) {
            return chineseMatch.join('');
        }
        
        const categoryMap = {
            'e-commerce': '电商案例',
            'portrait': '人像与摄影案例',
            'ui-social-media': 'UI与社交媒体模型案例',
            'poster-illustration': '海报与插画案例',
            'advertising': '广告创意案例',
            'character-design': '角色设计案例',
            'ecommerce': '电商案例',
            'portrait-photography': '人像与摄影案例',
            'ui-social': 'UI与社交媒体模型案例',
            'poster': '海报与插画案例',
            'advertising-creative': '广告创意案例',
            'character': '角色设计案例'
        };
        return categoryMap[cat.toLowerCase()] || cat;
    }

    renderCategories() {
        this.images.forEach(item => {
            item.category = this.cleanCategoryName(item.category);
        });

        const categories = ['all', ...new Set(this.images.map(item => item.category))];
        const categoryCounts = {};
        
        this.images.forEach(item => {
            categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
        });

        const categoryIcons = {
            'all': '📊',
            '电商案例': '🛒',
            '人像与摄影案例': '📸',
            'UI与社交媒体模型案例': '💻',
            '海报与插画案例': '🎨',
            '广告创意案例': '📢',
            '角色设计案例': '🎭'
        };

        const container = document.querySelector('.categories');
        if (!container) return;

        container.innerHTML = categories.map(cat => {
            const isActive = cat === this.currentCategory;
            const label = cat === 'all' ? '全部案例' : cat;
            const count = cat === 'all' ? this.images.length : (categoryCounts[cat] || 0);
            const icon = categoryIcons[cat] || '📁';

            return `
                <div class="category-item ${isActive ? 'active' : ''}" data-category="${cat}">
                    <span class="category-icon">${icon}</span>
                    <span>${label}</span>
                    <span class="category-count">${count}</span>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.category-item').forEach(item => {
            item.addEventListener('click', () => this.selectCategory(item.dataset.category));
        });
    }

    selectCategory(categoryId) {
        this.currentCategory = categoryId;
        
        document.querySelectorAll('.category-item').forEach(item => {
            item.classList.toggle('active', item.dataset.category === categoryId);
        });

        this.filterImages();
    }

    handleSearch(query) {
        query = query.toLowerCase().trim();
        this.filteredImages = this.images.filter(img => 
            img.title.toLowerCase().includes(query) ||
            img.prompt.toLowerCase().includes(query) ||
            img.category.toLowerCase().includes(query)
        );
        this.renderImages();
        this.updateStats();
    }

    filterImages() {
        const searchInput = document.getElementById('searchInput');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
        
        this.filteredImages = this.images.filter(item => {
            const matchCategory = this.currentCategory === 'all' || item.category === this.currentCategory;
            const matchSearch = !searchTerm ||
                item.title.toLowerCase().includes(searchTerm) ||
                item.prompt.toLowerCase().includes(searchTerm) ||
                item.category.toLowerCase().includes(searchTerm);
            return matchCategory && matchSearch;
        });
        
        this.renderImages();
        this.updateStats();
    }

    updateStats() {
        const countEl = document.getElementById('imageCount');
        if (countEl) {
            countEl.textContent = this.filteredImages.length;
        }
    }

    renderImages() {
        const grid = document.querySelector('.image-grid');
        if (!grid) return;

        if (this.filteredImages.length === 0) {
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📭</div>
                    <div class="empty-state-text">暂无图片</div>
                </div>
            `;
            return;
        }

        grid.innerHTML = this.filteredImages.map(img => {
            const imageUrl = img.cdn_image || (img.cdn_images && img.cdn_images[0]) || '';
            return `
                <div class="image-card" data-id="${img.id}">
                    <div class="image-wrapper">
                        <img src="${imageUrl}" alt="${img.title}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E🖼️%3C/text%3E%3C/svg%3E'">
                    </div>
                    <div class="image-info">
                        <div class="image-title">${img.title}</div>
                    </div>
                </div>
            `;
        }).join('');

        grid.querySelectorAll('.image-card').forEach(card => {
            card.addEventListener('click', () => this.openImageModal(card.dataset.id));
        });
    }

    openImageModal(imageId) {
        const image = this.images.find(img => img.id === parseInt(imageId));
        if (!image) return;

        const imageUrl = image.cdn_image || (image.cdn_images && image.cdn_images[0]) || '';
        
        const modal = document.querySelector('.modal');
        const modalContent = document.querySelector('.modal-content');
        
        modalContent.innerHTML = `
            <div class="modal-header">
                <span class="modal-title">${image.title}</span>
                <button class="modal-close">✕</button>
            </div>
            <div class="modal-body">
                <div class="modal-layout">
                    <div class="modal-image-wrapper">
                        <img src="${imageUrl}" alt="${image.title}" class="modal-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E🖼️%3C/text%3E%3C/svg%3E'">
                    </div>
                    <div class="modal-prompt-area">
                        <div class="prompt-section">
                            <span class="prompt-label">📝 提示词</span>
                            <button class="copy-btn">
                                <span>📋</span>
                                <span>复制</span>
                            </button>
                            <p class="prompt-text">${image.prompt}</p>
                        </div>
                    </div>
                </div>
            </div>
        `;

        modal.classList.add('active');

        modal.querySelector('.modal-close').addEventListener('click', () => this.closeModal());
        modal.querySelector('.copy-btn').addEventListener('click', (e) => {
            Utils.copyToClipboard(image.prompt, e.target);
        });
        modal.querySelector('.modal-image-wrapper').addEventListener('click', () => this.openZoom(imageUrl));
    }

    closeModal() {
        const modal = document.querySelector('.modal');
        modal.classList.remove('active');
    }

    openZoom(url) {
        const overlay = document.getElementById('imageZoomOverlay');
        const img = overlay.querySelector('img');
        img.src = url;
        overlay.classList.add('active');
    }

    closeZoom() {
        const overlay = document.getElementById('imageZoomOverlay');
        overlay.classList.remove('active');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new IndexPage();
});