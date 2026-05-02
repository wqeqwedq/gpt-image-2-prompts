const Utils = {
    showErrorToast: function(message) {
        const toast = document.getElementById('errorToast');
        if (toast) {
            toast.textContent = message;
            toast.classList.add('active');
            setTimeout(() => {
                toast.classList.remove('active');
            }, 3000);
        }
    },

    fetchWithTimeout: function(url, options = {}, timeout = 3000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        return fetch(url, {
            ...options,
            signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));
    },

    async fetchUserIP() {
        try {
            const response = await this.fetchWithTimeout('https://api.ipify.org?format=json');
            const data = await response.json();
            return data.ip;
        } catch (err) {
            console.warn('无法获取 IP 地址，将使用默认值');
            return 'unknown-' + Math.random().toString(36).substr(2, 9);
        }
    },

    copyToClipboard: async function(text, button) {
        try {
            await navigator.clipboard.writeText(text);
            if (button) {
                button.textContent = '✓ Copied';
                button.classList.add('copied');
                setTimeout(() => {
                    button.textContent = 'Copy';
                    button.classList.remove('copied');
                }, 2000);
            }
            return true;
        } catch (err) {
            console.error('复制失败:', err);
            return false;
        }
    },

    /**
     * 真实触发浏览器下载（保存到用户「下载」目录）。
     * 跨域 URL 上仅用 a[download] 往往无效，会先 fetch 为 Blob 再触发保存。
     */
    async downloadImage(url, filename) {
        if (!url || typeof url !== 'string') return false;
        const baseName = filename || 'image.png';
        try {
            const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const extFromType =
                blob.type === 'image/png'
                    ? '.png'
                    : blob.type === 'image/webp'
                      ? '.webp'
                      : blob.type === 'image/gif'
                        ? '.gif'
                        : '.jpg';
            let name = baseName;
            if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) {
                name = name.replace(/\.[^.]+$/, '') + extFromType;
            }
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = name;
            link.rel = 'noopener';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
            return true;
        } catch (err) {
            console.error('downloadImage:', err);
            return false;
        }
    },

    formatDate: function(date) {
        return new Date(date).toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }
};

export default Utils;
