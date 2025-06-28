class AutoRefresh {
  constructor(options = {}) {
    this.interval = options.interval || 120000; // 2 minutes default
    this.onUpdate = options.onUpdate || (() => {});
    this.onError = options.onError || console.error;
    this.enabled = true;
    this.timer = null;
    this.lastCheck = Date.now();
  }

  start() {
    if (this.timer) this.stop();
    
    this.timer = setInterval(async () => {
      if (!this.enabled) return;
      
      try {
        console.log('🔄 Auto-refresh checking for updates...');
        
        // Force refresh the server data
        const refreshResponse = await fetch('/api/refresh-data');
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          console.log('✅ Server data refreshed:', refreshData);
          
          // Notify the page to update
          this.onUpdate(refreshData, true);
        } else {
          throw new Error(`Refresh failed: ${refreshResponse.status}`);
        }
        
        this.lastCheck = Date.now();
      } catch (error) {
        console.error('❌ Auto-refresh error:', error);
        this.onError(error);
      }
    }, this.interval);
    
    console.log(`✅ Auto-refresh started (${this.interval/1000}s interval)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('⏹️ Auto-refresh stopped');
  }

  forceRefresh() {
    console.log('🔄 Force refresh triggered');
    this.onUpdate(null, true);
  }
}

// Add to window for global access
if (typeof window !== 'undefined') {
    window.AutoRefresh = AutoRefresh;
}