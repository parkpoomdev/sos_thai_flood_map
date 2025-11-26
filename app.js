// SOS Flood Map Application
class FloodMapApp {
    constructor() {
        this.map = null;
        this.markers = [];
        this.markerClusterGroup = null;
        this.allData = [];
        this.filteredData = [];
        this.worker = null;
        // ฝัง API endpoint สำหรับ SOS Flood
        this.apiUrl = 'https://storage.googleapis.com/pple-media/hdy-flood/sos.json';
        this.renderQueue = [];
        this.isRendering = false;
        this.debounceTimer = null;
        this.baseMaps = {};
        this.layerControl = null;
        this.visibleNotesData = [];
        this.currentDisplayCount = 8; // จำนวนรายการที่แสดงอยู่
        this.loadMoreIncrement = 100; // โหลดเพิ่มทีละ 100 รายการ
        this.savedDisplayCount = 8; // เก็บจำนวนรายการเมื่อซ่อน panel
        this.autoRefreshInterval = null; // Auto-refresh interval
        this.autoRefreshMinutes = 5; // Auto-refresh every 5 minutes
        this.lastFetchedAt = null; // เก็บ fetched_at ล่าสุด
        this.lastUpdateTime = null; // เวลาที่อัปเดตล่าสุด
        this.savedMapBounds = null; // เก็บ bounds ของ map เมื่อ collapse
        this.intersectionObserver = null; // Intersection Observer สำหรับ infinite scroll
        this.isLoadingMore = false; // Flag เพื่อป้องกันการโหลดซ้ำ
        
        this.init();
    }

    init() {
        // Initialize Map
        this.initMap();
        
        // Initialize Web Worker
        this.initWorker();
        
        // Setup Event Listeners
        this.setupEventListeners();
        
        // Load cached data or fetch new data
        this.loadData();
        
        // Start auto-refresh
        this.startAutoRefresh();
    }

    initMap() {
        // Check if Leaflet is loaded
        if (typeof L === 'undefined') {
            console.error('Leaflet library is not loaded');
            document.getElementById('map').innerHTML = 
                '<div style="padding: 20px; text-align: center; color: red;">' +
                '<h3>⚠️ ไม่สามารถโหลด Leaflet ได้</h3>' +
                '<p>กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตและรีเฟรชหน้าเว็บ</p>' +
                '</div>';
            return;
        }
        
        try {
            // Initialize Leaflet map centered on หาดใหญ่ (Hat Yai)
            // Coordinates: [latitude, longitude] for หาดใหญ่, สงขลา
            this.map = L.map('map').setView([6.9917, 100.4681], 13);
            
            // สร้าง base maps
            const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19
            });
            
            const cartoDBLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors, © CartoDB',
                maxZoom: 19
            });
            
            // เก็บ base maps ไว้ใน instance
            this.baseMaps = {
                "OpenStreetMap": openStreetMap,
                "CartoDB Light Gray": cartoDBLight
            };
            
            // เพิ่ม layer control (ซ่อนไว้ ใช้ dropdown ใน UI แทน)
            // this.layerControl = L.control.layers(this.baseMaps).addTo(this.map);
            
            // ตั้งค่าเริ่มต้นเป็น OpenStreetMap
            openStreetMap.addTo(this.map);
            
            // โหลดการตั้งค่าจาก localStorage
            const savedMapStyle = localStorage.getItem('map_style') || 'OpenStreetMap';
            if (this.baseMaps[savedMapStyle]) {
                this.map.removeLayer(openStreetMap);
                this.baseMaps[savedMapStyle].addTo(this.map);
            }
            
            // Setup map events for notes panel
            this.setupMapEvents();
        } catch (error) {
            console.error('Error initializing map:', error);
            document.getElementById('map').innerHTML = 
                '<div style="padding: 20px; text-align: center; color: red;">' +
                '<h3>⚠️ เกิดข้อผิดพลาดในการสร้างแผนที่</h3>' +
                '<p>' + error.message + '</p>' +
                '</div>';
        }
    }

    initWorker() {
        if (typeof Worker !== 'undefined') {
            this.worker = new Worker('data-worker.js');
            
            this.worker.onmessage = (e) => {
                const { type, data } = e.data;
                
                if (type === 'data_processed') {
                    this.allData = data;
                    this.updateSubdistrictList();
                    this.updateVictimTypesList();
                    this.applyFilters();
                    this.hideLoading();
                } else if (type === 'error') {
                    console.error('Worker error:', data);
                    this.hideLoading();
                    alert('เกิดข้อผิดพลาดในการประมวลผลข้อมูล: ' + data);
                }
            };
            
            this.worker.onerror = (error) => {
                console.error('Worker error:', error);
                this.hideLoading();
            };
        } else {
            console.warn('Web Workers not supported, falling back to main thread');
        }
    }

    setupEventListeners() {
        // Status checkboxes - with debounce
        document.querySelectorAll('input[name="status"]').forEach(checkbox => {
            checkbox.addEventListener('change', () => this.debouncedApplyFilters());
        });

        // Victims checkboxes - with debounce (will be attached in updateVictimTypesList)
        
        // Victim filter mode radio buttons
        document.querySelectorAll('input[name="victimFilterMode"]').forEach(radio => {
            radio.addEventListener('change', () => this.debouncedApplyFilters());
        });
        
        // Check all victims button
        document.getElementById('checkAllVictimsBtn').addEventListener('click', () => {
            this.checkAllVictims(true);
        });
        
        // Uncheck all victims button
        document.getElementById('uncheckAllVictimsBtn').addEventListener('click', () => {
            this.checkAllVictims(false);
        });

        // Subdistrict filter - with debounce and zoom
        const subdistrictFilter = document.getElementById('subdistrictFilter');
        subdistrictFilter.addEventListener('change', () => {
            this.debouncedApplyFilters();
            // Zoom to selected subdistrict
            const selectedValue = subdistrictFilter.value;
            if (selectedValue && selectedValue !== 'all') {
                this.zoomToSubdistrict(selectedValue);
            }
        });

        // Refresh button
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadData(true);
        });
        
        // Map style selector
        const mapStyleSelect = document.getElementById('mapStyleSelect');
        if (mapStyleSelect) {
            // โหลดการตั้งค่าจาก localStorage
            const savedMapStyle = localStorage.getItem('map_style') || 'OpenStreetMap';
            mapStyleSelect.value = savedMapStyle;
            
            mapStyleSelect.addEventListener('change', (e) => {
                const selectedStyle = e.target.value;
                this.changeMapStyle(selectedStyle);
            });
        }
        
        // Cache checkbox - clear cache if disabled
        document.getElementById('useCache').addEventListener('change', (e) => {
            if (!e.target.checked) {
                // Clear cache when disabled
                this.clearCache();
            }
            this.updateCacheInfo();
        });
        
        // Clear cache button
        document.getElementById('clearCacheBtn').addEventListener('click', () => {
            if (confirm('ต้องการล้าง Cache หรือไม่?')) {
                if (this.clearCache()) {
                    alert('ล้าง Cache สำเร็จแล้ว');
                    this.updateCacheInfo();
                } else {
                    alert('เกิดข้อผิดพลาดในการล้าง Cache');
                }
            }
        });
        
        // Update cache info on load
        this.updateCacheInfo();
        
        // Toggle notes panel button
        document.getElementById('toggleNotesPanelBtn').addEventListener('click', () => {
            this.toggleNotesPanel();
        });
        
        // Show notes panel button (เมื่อ panel ถูกซ่อน) - Desktop only
        const showNotesPanelBtn = document.getElementById('showNotesPanelBtn');
        if (showNotesPanelBtn) {
            // เริ่มต้นซ่อน container
            const showContainer = showNotesPanelBtn.closest('.show-notes-container');
            if (showContainer) {
                showContainer.classList.remove('show');
            } else {
                showNotesPanelBtn.classList.remove('show');
            }
            
            showNotesPanelBtn.addEventListener('click', () => {
                const panel = document.getElementById('notesPanel');
                const isMobile = window.innerWidth <= 768;
                // ทำงานเฉพาะ desktop และเมื่อ panel ถูกซ่อนอยู่
                if (!isMobile && panel && panel.classList.contains('collapsed')) {
                    this.toggleNotesPanel();
                }
            });
        }
        
        // Toggle filter panel button (mobile)
        const toggleFilterPanelBtn = document.getElementById('toggleFilterPanelBtn');
        if (toggleFilterPanelBtn) {
            toggleFilterPanelBtn.addEventListener('click', () => {
                this.toggleFilterPanel();
            });
        }
        
        // Toggle map container button (mobile)
        const toggleMapContainerBtn = document.getElementById('toggleMapContainerBtn');
        if (toggleMapContainerBtn) {
            toggleMapContainerBtn.addEventListener('click', () => {
                this.toggleMapContainer();
            });
        }
        
        // Setup mobile detection and initial state
        this.setupMobileSupport();
    }
    
    setupMapEvents() {
        // อัปเดต notes panel เมื่อ map move หรือ zoom
        let updateTimer = null;
        const updateNotes = () => {
            if (updateTimer) {
                clearTimeout(updateTimer);
            }
            updateTimer = setTimeout(() => {
                this.updateNotesPanel();
            }, 300); // Debounce 300ms
        };
        
        this.map.on('moveend', updateNotes);
        this.map.on('zoomend', updateNotes);
    }
    
    toggleNotesPanel() {
        const panel = document.getElementById('notesPanel');
        const btn = document.getElementById('toggleNotesPanelBtn');
        const showBtn = document.getElementById('showNotesPanelBtn');
        
        if (!panel || !btn) {
            console.error('Notes panel elements not found');
            return;
        }
        
        // ตรวจสอบว่าเป็น mobile หรือไม่
        const isMobile = window.innerWidth <= 768;
        
        // ใน mobile ไม่ให้ collapse
        if (isMobile) {
            return;
        }
        
        const isCollapsing = !panel.classList.contains('collapsed');
        
        if (isCollapsing) {
            // กำลังจะซ่อน - เก็บจำนวนรายการปัจจุบัน
            this.savedDisplayCount = this.currentDisplayCount;
            // เพิ่ม class เพื่อป้องกัน hover effect
            panel.classList.add('no-hover');
            // แสดงปุ่มเปิดคืน (Desktop only) - ใช้ class show ที่ container
            if (!isMobile) {
                const showContainer = showBtn ? showBtn.closest('.show-notes-container') : null;
                if (showContainer) {
                    showContainer.classList.add('show');
                } else if (showBtn) {
                    // Fallback: ถ้าไม่มี container ให้ใช้ที่ปุ่ม
                    showBtn.classList.add('show');
                }
            }
        } else {
            // กำลังจะเปิด - คืนค่าจำนวนรายการ
            this.currentDisplayCount = this.savedDisplayCount;
            // ลบ class no-hover
            panel.classList.remove('no-hover');
            // ซ่อนปุ่มเปิดคืน - ลบ class show จาก container
            const showContainer = showBtn ? showBtn.closest('.show-notes-container') : null;
            if (showContainer) {
                showContainer.classList.remove('show');
            } else if (showBtn) {
                // Fallback: ถ้าไม่มี container ให้ใช้ที่ปุ่ม
                showBtn.classList.remove('show');
            }
            // Render ใหม่โดยไม่ reset count
            if (this.visibleNotesData && this.visibleNotesData.length > 0) {
                this.renderNotesList(this.visibleNotesData, false);
            }
        }
        
        // Toggle collapsed class
        panel.classList.toggle('collapsed');
        
        // เพิ่ม/ลบ class ให้ map-container เพื่อขยายพื้นที่
        const mapContainer = document.getElementById('mapContainer');
        if (mapContainer) {
            if (panel.classList.contains('collapsed')) {
                mapContainer.classList.add('notes-panel-collapsed');
            } else {
                mapContainer.classList.remove('notes-panel-collapsed');
            }
        }
        
        // เปลี่ยน icon ตามสถานะ - Desktop only
        btn.textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
        
        // Force map resize after panel toggle
        if (this.map) {
            setTimeout(() => {
                this.map.invalidateSize();
            }, 300);
        }
        
        console.log('Panel toggled:', panel.classList.contains('collapsed') ? 'collapsed' : 'expanded');
    }
    
    toggleFilterPanel() {
        const panel = document.querySelector('.filter-panel');
        const btn = document.getElementById('toggleFilterPanelBtn');
        
        if (!panel || !btn) {
            console.error('Filter panel elements not found');
            return;
        }
        
        panel.classList.toggle('collapsed');
        btn.textContent = panel.classList.contains('collapsed') ? '▲' : '▼';
        
        // Force map resize after panel toggle
        if (this.map) {
            setTimeout(() => {
                this.map.invalidateSize();
            }, 300);
        }
    }
    
    toggleMapContainer() {
        const container = document.getElementById('mapContainer');
        const btn = document.getElementById('toggleMapContainerBtn');
        
        if (!container || !btn) {
            console.error('Map container elements not found');
            return;
        }
        
        const isCollapsing = !container.classList.contains('collapsed');
        container.classList.toggle('collapsed');
        btn.textContent = container.classList.contains('collapsed') ? '▲' : '▼';
        
        if (this.map) {
            if (isCollapsing) {
                // กำลังจะ collapse - เก็บ bounds ปัจจุบันไว้
                this.savedMapBounds = this.map.getBounds();
                console.log('Map collapsed, saved bounds:', this.savedMapBounds);
            } else {
                // กำลังจะ expand - ใช้ bounds ที่เก็บไว้ (ถ้ามี)
                if (this.savedMapBounds) {
                    setTimeout(() => {
                        this.map.setView(this.savedMapBounds.getCenter(), this.map.getZoom(), {
                            animate: false
                        });
                        this.savedMapBounds = null; // ล้าง saved bounds หลังจากใช้
                    }, 100);
                }
            }
            
            // Force map resize after toggle
            setTimeout(() => {
                this.map.invalidateSize();
            }, 300);
        }
        
        // ไม่ต้อง update notes panel เมื่อ collapse/expand เพราะต้องการใช้ข้อมูลพื้นที่เดิม
        // Notes panel จะยังคงแสดงข้อมูลตาม bounds ที่เก็บไว้
    }
    
    setupMobileSupport() {
        // Check if mobile device
        const isMobile = window.innerWidth <= 768;
        
        // Show/hide mobile toggle buttons
        const toggleFilterBtn = document.getElementById('toggleFilterPanelBtn');
        const toggleMapBtn = document.getElementById('toggleMapContainerBtn');
        const mapHeader = document.querySelector('.map-container-header');
        const toggleNotesBtn = document.getElementById('toggleNotesPanelBtn');
        const showNotesBtn = document.getElementById('showNotesPanelBtn');
        const notesPanel = document.getElementById('notesPanel');
        
        if (toggleFilterBtn) {
            if (isMobile) {
                toggleFilterBtn.style.display = 'flex';
            } else {
                toggleFilterBtn.style.display = 'none';
                // Remove collapsed class on desktop
                const filterPanel = document.querySelector('.filter-panel');
                if (filterPanel) {
                    filterPanel.classList.remove('collapsed');
                }
            }
        }
        
        if (toggleMapBtn && mapHeader) {
            if (isMobile) {
                mapHeader.style.display = 'flex';
            } else {
                mapHeader.style.display = 'none';
                // Remove collapsed class on desktop
                const mapContainer = document.getElementById('mapContainer');
                if (mapContainer) {
                    mapContainer.classList.remove('collapsed');
                }
            }
        }
        
        // Notes panel - ใน mobile ให้แสดงเสมอ
        const mapContainer = document.getElementById('mapContainer');
        if (notesPanel) {
            if (isMobile) {
                // Mobile: ลบ collapsed class และซ่อน toggle button
                notesPanel.classList.remove('collapsed');
                notesPanel.classList.remove('no-hover');
                if (mapContainer) {
                    mapContainer.classList.remove('notes-panel-collapsed');
                }
                if (toggleNotesBtn) {
                    toggleNotesBtn.style.display = 'none';
                }
                if (showNotesBtn) {
                    showNotesBtn.style.display = 'none';
                }
            } else {
                // Desktop: แสดง toggle button และจัดการ show button
                if (toggleNotesBtn) {
                    toggleNotesBtn.style.display = 'flex';
                }
                if (showNotesBtn) {
                    // แสดงเฉพาะเมื่อ panel ถูกซ่อนอยู่ - ใช้ class show ที่ container
                    const showContainer = showNotesBtn.closest('.show-notes-container');
                    if (notesPanel.classList.contains('collapsed')) {
                        if (showContainer) {
                            showContainer.classList.add('show');
                        } else {
                            showNotesBtn.classList.add('show');
                        }
                        // เพิ่ม class ให้ map-container เพื่อขยายพื้นที่
                        if (mapContainer) {
                            mapContainer.classList.add('notes-panel-collapsed');
                        }
                    } else {
                        if (showContainer) {
                            showContainer.classList.remove('show');
                        } else {
                            showNotesBtn.classList.remove('show');
                        }
                        // ลบ class จาก map-container
                        if (mapContainer) {
                            mapContainer.classList.remove('notes-panel-collapsed');
                        }
                    }
                } else {
                    // ถ้าไม่มี showBtn ให้ตรวจสอบสถานะ panel และจัดการ map-container
                    if (mapContainer) {
                        if (notesPanel.classList.contains('collapsed')) {
                            mapContainer.classList.add('notes-panel-collapsed');
                        } else {
                            mapContainer.classList.remove('notes-panel-collapsed');
                        }
                    }
                }
            }
        }
        
        // Handle window resize
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const nowMobile = window.innerWidth <= 768;
                if (toggleFilterBtn) {
                    if (nowMobile) {
                        toggleFilterBtn.style.display = 'flex';
                    } else {
                        toggleFilterBtn.style.display = 'none';
                        // Remove collapsed class on desktop
                        const filterPanel = document.querySelector('.filter-panel');
                        if (filterPanel) {
                            filterPanel.classList.remove('collapsed');
                        }
                    }
                }
                
                if (toggleMapBtn && mapHeader) {
                    if (nowMobile) {
                        mapHeader.style.display = 'flex';
                    } else {
                        mapHeader.style.display = 'none';
                        // Remove collapsed class on desktop
                        const mapContainer = document.getElementById('mapContainer');
                        if (mapContainer) {
                            mapContainer.classList.remove('collapsed');
                        }
                    }
                }
                
                // Notes panel - ใน mobile ให้แสดงเสมอ
                const notesPanel = document.getElementById('notesPanel');
                const toggleNotesBtn = document.getElementById('toggleNotesPanelBtn');
                const showNotesBtn = document.getElementById('showNotesPanelBtn');
                const mapContainer = document.getElementById('mapContainer');
                if (notesPanel) {
                    if (nowMobile) {
                        // Mobile: ลบ collapsed class และซ่อน toggle button
                        notesPanel.classList.remove('collapsed');
                        notesPanel.classList.remove('no-hover');
                        if (mapContainer) {
                            mapContainer.classList.remove('notes-panel-collapsed');
                        }
                        if (toggleNotesBtn) {
                            toggleNotesBtn.style.display = 'none';
                        }
                        if (showNotesBtn) {
                            showNotesBtn.style.display = 'none';
                        }
                    } else {
                        // Desktop: แสดง toggle button และจัดการ show button
                        if (toggleNotesBtn) {
                            toggleNotesBtn.style.display = 'flex';
                        }
                        if (showNotesBtn) {
                            // แสดงเฉพาะเมื่อ panel ถูกซ่อนอยู่ - ใช้ class show ที่ container
                            const showContainer = showNotesBtn.closest('.show-notes-container');
                            if (notesPanel.classList.contains('collapsed')) {
                                if (showContainer) {
                                    showContainer.classList.add('show');
                                } else {
                                    showNotesBtn.classList.add('show');
                                }
                                // เพิ่ม class ให้ map-container เพื่อขยายพื้นที่
                                if (mapContainer) {
                                    mapContainer.classList.add('notes-panel-collapsed');
                                }
                            } else {
                                if (showContainer) {
                                    showContainer.classList.remove('show');
                                } else {
                                    showNotesBtn.classList.remove('show');
                                }
                                // ลบ class จาก map-container
                                if (mapContainer) {
                                    mapContainer.classList.remove('notes-panel-collapsed');
                                }
                            }
                        } else {
                            // ถ้าไม่มี showBtn ให้ตรวจสอบสถานะ panel และจัดการ map-container
                            if (mapContainer) {
                                if (notesPanel.classList.contains('collapsed')) {
                                    mapContainer.classList.add('notes-panel-collapsed');
                                } else {
                                    mapContainer.classList.remove('notes-panel-collapsed');
                                }
                            }
                        }
                    }
                }
                
                // Force map resize on orientation change
                if (this.map) {
                    setTimeout(() => {
                        this.map.invalidateSize();
                    }, 100);
                }
            }, 250);
        });
        
        // Handle orientation change
        window.addEventListener('orientationchange', () => {
            setTimeout(() => {
                if (this.map) {
                    this.map.invalidateSize();
                }
            }, 500);
        });
    }
    
    updateNotesPanel() {
        if (!this.map) return;
        
        // ดึง bounds - ใช้ saved bounds ถ้า map ถูก collapse อยู่
        let bounds;
        const mapContainer = document.getElementById('mapContainer');
        if (mapContainer && mapContainer.classList.contains('collapsed') && this.savedMapBounds) {
            // ใช้ bounds ที่เก็บไว้เมื่อ map ถูก collapse
            bounds = this.savedMapBounds;
        } else {
            // ใช้ bounds ปัจจุบันจาก map
            bounds = this.map.getBounds();
            // อัปเดต saved bounds ถ้า map ไม่ได้ collapse
            this.savedMapBounds = bounds;
        }
        
        // กรองข้อมูลที่อยู่ใน bounds และผ่าน filter แล้ว
        const visibleData = this.filteredData.filter(item => {
            if (!item.coordinates || item.coordinates.length !== 2) {
                return false;
            }
            const [lng, lat] = item.coordinates;
            return bounds.contains([lat, lng]);
        });
        
        // คัดกรองเฉพาะข้อความที่มีหมายเหตุเท่านั้น
        const notesOnlyData = visibleData.filter(item => {
            return item.other && item.other.trim().length > 0;
        });
        
        // เรียงตาม other field (มีข้อมูลมาก่อน) - แต่ตอนนี้ทุกรายการมีหมายเหตุแล้ว
        notesOnlyData.sort((a, b) => {
            const aHasNote = a.other && a.other.trim().length > 0;
            const bHasNote = b.other && b.other.trim().length > 0;
            
            if (aHasNote && !bHasNote) return -1;
            if (!aHasNote && bHasNote) return 1;
            return 0;
        });
        
        // แสดงรายการ (reset count เฉพาะเมื่อ bounds เปลี่ยนจริงๆ)
        // ตรวจสอบว่าเป็นข้อมูลชุดเดิมหรือไม่
        const isSameData = this.visibleNotesData.length === notesOnlyData.length && 
                          this.visibleNotesData.length > 0 &&
                          this.visibleNotesData.every((item, index) => item.id === notesOnlyData[index]?.id);
        
        // อัปเดต title ของ notes panel header
        this.updateNotesPanelTitle(notesOnlyData.length);
        
        this.renderNotesList(notesOnlyData, !isSameData);
    }
    
    renderNotesList(data, resetCount = true) {
        const container = document.getElementById('notesContent');
        if (!container) return;
        
        if (data.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #6c757d; padding: 20px;">ไม่มีข้อความที่มีหมายเหตุในพื้นที่นี้</div>';
            this.currentDisplayCount = 8;
            this.updateNotesPanelTitle(0);
            return;
        }
        
        // Reset count ถ้าเป็นข้อมูลใหม่
        if (resetCount) {
            this.currentDisplayCount = 8;
        }
        
        // แสดงรายการตาม currentDisplayCount
        const displayData = data.slice(0, this.currentDisplayCount);
        const hasMore = data.length > this.currentDisplayCount;
        const remaining = data.length - this.currentDisplayCount;
        
        let html = '';
        let previousLoadCount = 0;
        
        displayData.forEach((item, index) => {
            // เพิ่มเส้นแบ่งและ header ชัดเจนที่จุดเริ่มต้นของข้อมูลที่โหลดใหม่ (ที่ 8, 108, 208, ...)
            // index 0-7 = ชุดแรก (8 รายการ), 8-107 = ชุดที่ 2 (100 รายการ), 108-207 = ชุดที่ 3 (100 รายการ), ...
            if (index > 0 && (index === 8 || (index > 8 && (index - 8) % this.loadMoreIncrement === 0))) {
                const batchNumber = index === 8 ? 2 : Math.floor((index - 8) / this.loadMoreIncrement) + 2;
                const startIndex = index + 1; // 1-based index
                html += `
                    <div class="notes-separator" id="batch-separator-${batchNumber}">
                        <div class="separator-line"></div>
                        <span class="separator-text">━━━ ข้อความใหม่ ━━━</span>
                        <div class="separator-line"></div>
                    </div>
                    <div class="batch-header" id="batch-header-${batchNumber}">
                        <div class="batch-indicator"></div>
                        <div class="batch-info">
                            <span class="batch-range">รายการที่ ${startIndex} - ${Math.min(startIndex + this.loadMoreIncrement - 1, data.length)}</span>
                        </div>
                    </div>
                `;
            }
            
            const hasNote = item.other && item.other.trim().length > 0;
            const statusClass = item.status === 0 ? 'status-0' : 'status-3';
            const statusText = item.status === 0 ? 'รอการช่วยเหลือ' : 'กำลังช่วยเหลือ';
            const statusBg = item.status === 0 ? '#ffc107' : '#17a2b8';
            
            // Format timestamp
            let timestampHtml = '';
            if (item.updated_at) {
                try {
                    const updateDate = new Date(item.updated_at);
                    const formattedDate = updateDate.toLocaleString('th-TH', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    timestampHtml = `<div class="note-card-timestamp">🕒 ${formattedDate}</div>`;
                } catch (e) {
                    // ถ้า parse ไม่ได้ ไม่แสดง timestamp
                }
            }
            
            html += `
                <div class="note-card ${hasNote ? 'has-note' : 'empty-note'}" data-id="${item.id}">
                    <div class="note-card-header">
                        <div class="note-card-title">${item.runningNumber || item.id || 'N/A'}</div>
                        <span class="note-card-status ${statusClass}" style="background: ${statusBg}; color: ${item.status === 0 ? '#000' : '#fff'};">${statusText}</span>
                    </div>
                    <div class="note-card-body">
                        ${hasNote ? item.other : '<em>ไม่มีหมายเหตุ</em>'}
                    </div>
                    ${timestampHtml}
                    <div class="note-card-footer">
                        <div class="note-card-location">
                            ${item.subdistrict ? item.subdistrict + ', ' : ''}${item.district || ''}${item.province ? ', ' + item.province : ''}
                        </div>
                        <div class="note-card-actions">
                            <button class="google-map-btn" onclick="window.floodMapApp.openGoogleMaps(${item.coordinates[1]}, ${item.coordinates[0]})" title="เปิดใน Google Maps">
                                🗺️
                            </button>
                            <button class="focus-btn" onclick="window.floodMapApp.focusMarker('${item.id}')">📍 สถานที่</button>
                        </div>
                    </div>
                </div>
            `;
        });
        
        // เพิ่มสถานะจำนวนรายการ
        html = `
            <div style="padding: 10px 15px; background: #e9ecef; border-radius: 5px; margin-bottom: 15px; text-align: center; font-size: 0.9rem; color: #495057;">
                <strong>${this.currentDisplayCount} จาก ${data.length} ข้อความ</strong>
            </div>
        ` + html;
        
        if (hasMore) {
            const loadMoreCount = Math.min(this.loadMoreIncrement, remaining);
            const isMobile = window.innerWidth <= 768;
            
            if (isMobile) {
                // Mobile: สร้าง sentinel element สำหรับ infinite scroll
                html += `
                    <div id="loadMoreSentinel" style="height: 20px; padding: 10px;"></div>
                    <div class="load-more-indicator" style="display: none; text-align: center; padding: 15px; color: #6c757d; font-size: 0.9rem;">
                        <div class="spinner-small" style="border: 2px solid #f3f3f3; border-top: 2px solid #6c757d; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 0 auto 8px;"></div>
                        กำลังโหลดข้อมูลเพิ่มเติม...
                    </div>
                `;
            } else {
                // Desktop: แสดงปุ่มโหลดเพิ่มเติม
                html += `
                    <div style="text-align: center; padding: 15px; padding-bottom: 20px; margin-bottom: 20px;">
                        <button class="small-btn load-more-btn" style="width: 100%; background: #6c757d; min-height: 44px; font-size: 0.9rem; padding: 12px;" onclick="window.floodMapApp.loadMoreNotes()">
                            📋 แสดงเพิ่มเติม ${loadMoreCount} รายการ (เหลืออีก ${remaining} รายการ)
                        </button>
                    </div>
                `;
            }
        }
        
        container.innerHTML = html;
        
        // เก็บข้อมูลทั้งหมดไว้สำหรับ loadMoreNotes
        this.visibleNotesData = data;
        
        // อัปเดต title ของ notes panel header
        const displayedCount = Math.min(this.currentDisplayCount, data.length);
        this.updateNotesPanelTitle(data.length, displayedCount);
        
        // Setup infinite scroll สำหรับ mobile
        if (hasMore) {
            this.setupInfiniteScroll();
        }
    }
    
    loadMoreNotes() {
        if (!this.visibleNotesData || this.visibleNotesData.length === 0) return;
        if (this.isLoadingMore) return; // ป้องกันการโหลดซ้ำ
        
        this.isLoadingMore = true;
        const isMobile = window.innerWidth <= 768;
        
        // แสดง loading indicator บน mobile
        if (isMobile) {
            const loadingIndicator = document.querySelector('.load-more-indicator');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'block';
            }
        }
        
        // คำนวณ batch number ที่จะโหลด (ชุดถัดไป)
        const previousCount = this.currentDisplayCount;
        const nextBatchNumber = previousCount === 8 ? 2 : Math.floor((previousCount - 8) / this.loadMoreIncrement) + 2;
        
        // เพิ่มจำนวนรายการที่แสดง
        this.currentDisplayCount += this.loadMoreIncrement;
        
        // ถ้าเกินจำนวนทั้งหมด ให้แสดงทั้งหมด
        if (this.currentDisplayCount >= this.visibleNotesData.length) {
            this.currentDisplayCount = this.visibleNotesData.length;
        }
        
        // Render ใหม่โดยไม่ reset count
        this.renderNotesList(this.visibleNotesData, false);
        
        this.isLoadingMore = false;
        
        // Scroll ไปที่จุดเริ่มต้นของชุดข้อมูลใหม่ (separator) - เฉพาะ desktop
        if (!isMobile) {
            const container = document.getElementById('notesContent');
            if (container) {
                setTimeout(() => {
                    // หา separator ของชุดที่โหลดใหม่
                    const batchSeparator = document.getElementById(`batch-separator-${nextBatchNumber}`);
                    if (batchSeparator) {
                        // Scroll ไปที่ separator โดยให้อยู่ที่ top ของ panel
                        batchSeparator.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    } else {
                        // ถ้าหาไม่เจอ ให้ scroll ไปที่ batch header แทน
                        const batchHeader = document.getElementById(`batch-header-${nextBatchNumber}`);
                        if (batchHeader) {
                            batchHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        } else {
                            // ถ้ายังหาไม่เจอ ให้ scroll ไปที่ top ของ container
                            container.scrollTop = 0;
                        }
                    }
                }, 100);
            }
        }
    }
    
    setupInfiniteScroll() {
        // ลบ observer เดิมถ้ามี
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        
        const isMobile = window.innerWidth <= 768;
        if (!isMobile) return; // ใช้เฉพาะ mobile
        
        const sentinel = document.getElementById('loadMoreSentinel');
        if (!sentinel) return;
        
        // สร้าง Intersection Observer
        this.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !this.isLoadingMore) {
                    // เมื่อเห็น sentinel element ให้โหลดข้อมูลเพิ่ม
                    this.loadMoreNotes();
                }
            });
        }, {
            root: document.getElementById('notesContent'),
            rootMargin: '100px', // เริ่มโหลดก่อนถึง 100px
            threshold: 0.1
        });
        
        // เริ่ม observe sentinel element
        this.intersectionObserver.observe(sentinel);
    }
    
    updateNotesPanelTitle(totalCount, displayedCount = null) {
        const header = document.querySelector('.notes-panel-header h2');
        if (header) {
            const count = displayedCount !== null ? displayedCount : Math.min(this.currentDisplayCount, totalCount);
            if (totalCount > 0) {
                header.textContent = `📝 หมายเหตุ (${count}${totalCount > count ? `/${totalCount}` : ''})`;
            } else {
                header.textContent = '📝 หมายเหตุ';
            }
        }
    }
    
    openGoogleMaps(latitude, longitude) {
        // เปิด Google Maps ในแท็บใหม่ด้วยพิกัด
        const googleMapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        window.open(googleMapsUrl, '_blank');
    }
    
    focusMarker(itemId) {
        // หา marker ที่ตรงกับ itemId
        let targetMarker = null;
        
        if (this.markerClusterGroup) {
            this.markerClusterGroup.eachLayer((marker) => {
                if (marker.options && marker.options.itemId === itemId) {
                    targetMarker = marker;
                }
            });
        } else {
            targetMarker = this.markers.find(m => m.options && m.options.itemId === itemId);
        }
        
        if (targetMarker) {
            // Zoom และ pan ไปที่ marker (zoom มากขึ้น 2 level หรืออย่างน้อย 17)
            const latlng = targetMarker.getLatLng();
            const currentZoom = this.map.getZoom();
            const targetZoom = Math.max(currentZoom + 2, 17);
            this.map.setView(latlng, targetZoom, {
                animate: true,
                duration: 0.5
            });
            
            // เปิด popup
            targetMarker.openPopup();
            
            // Highlight marker
            if (targetMarker.setIcon) {
                const originalIcon = targetMarker.options.icon;
                const highlightIcon = L.divIcon({
                    className: 'custom-marker',
                    html: `<div style="
                        width: 25px;
                        height: 25px;
                        background: #dc3545;
                        border: 3px solid white;
                        border-radius: 50%;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
                    "></div>`,
                    iconSize: [25, 25],
                    iconAnchor: [12, 12]
                });
                targetMarker.setIcon(highlightIcon);
                
                // คืนค่า icon เดิมหลังจาก 2 วินาที
                setTimeout(() => {
                    targetMarker.setIcon(originalIcon);
                }, 2000);
            }
        }
    }
    
    updateCacheInfo() {
        const cacheSize = this.getCacheSize();
        const cacheSizeInfo = document.getElementById('cacheSizeInfo');
        if (cacheSize > 0) {
            const sizeMB = (cacheSize / 1024 / 1024).toFixed(2);
            cacheSizeInfo.textContent = `Cache: ${sizeMB} MB`;
            cacheSizeInfo.style.color = cacheSize > 3 * 1024 * 1024 ? '#dc3545' : '#6c757d';
        } else {
            cacheSizeInfo.textContent = 'ไม่มี Cache';
            cacheSizeInfo.style.color = '#6c757d';
        }
    }
    
    clearCache() {
        try {
            localStorage.removeItem('flood_data_cache');
            localStorage.removeItem('flood_data_timestamp');
            console.log('Cache cleared successfully');
            return true;
        } catch (e) {
            console.error('Error clearing cache:', e);
            return false;
        }
    }
    
    getCacheSize() {
        try {
            const cacheData = localStorage.getItem('flood_data_cache');
            if (cacheData) {
                return new Blob([cacheData]).size;
            }
            return 0;
        } catch (e) {
            return 0;
        }
    }

    async loadData(forceRefresh = false) {
        this.showLoading();
        
        // Check cache first
        const useCache = document.getElementById('useCache').checked;
        const cacheKey = 'flood_data_cache';
        const cacheTimestampKey = 'flood_data_timestamp';
        
        if (!forceRefresh && useCache) {
            const cachedData = localStorage.getItem(cacheKey);
            const cacheTimestamp = localStorage.getItem(cacheTimestampKey);
            
            if (cachedData && cacheTimestamp) {
                const cacheAge = Date.now() - parseInt(cacheTimestamp);
                const maxAge = 5 * 60 * 1000; // 5 minutes
                
                if (cacheAge < maxAge) {
                    try {
                        const data = JSON.parse(cachedData);
                        // เก็บ fetched_at จาก cache
                        if (data.fetched_at) {
                            this.lastFetchedAt = data.fetched_at;
                        }
                        this.lastUpdateTime = new Date(parseInt(cacheTimestamp));
                        this.updateLastUpdateDisplay();
                        this.processData(data);
                        this.hideLoading();
                        return;
                    } catch (e) {
                        console.error('Error parsing cached data:', e);
                    }
                }
            }
        }
        
        // Fetch new data
        try {
            const response = await fetch(this.apiUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            // เก็บ fetched_at และเวลาอัปเดตสำหรับตรวจสอบการเปลี่ยนแปลง
            if (data.fetched_at) {
                this.lastFetchedAt = data.fetched_at;
            }
            this.lastUpdateTime = new Date();
            this.updateLastUpdateDisplay();
            
            // Cache the data (with size check and error handling)
            if (useCache) {
                try {
                    const dataString = JSON.stringify(data);
                    const dataSize = new Blob([dataString]).size; // Size in bytes
                    const maxCacheSize = 4 * 1024 * 1024; // 4MB limit (LocalStorage usually has 5-10MB)
                    
                    if (dataSize > maxCacheSize) {
                        console.warn(`Data size (${(dataSize / 1024 / 1024).toFixed(2)}MB) exceeds cache limit. Skipping cache.`);
                        // Clear old cache to free space
                        try {
                            localStorage.removeItem(cacheKey);
                            localStorage.removeItem(cacheTimestampKey);
                        } catch (e) {
                            console.warn('Could not clear old cache:', e);
                        }
                    } else {
                        localStorage.setItem(cacheKey, dataString);
                        localStorage.setItem(cacheTimestampKey, Date.now().toString());
                        console.log(`Data cached successfully (${(dataSize / 1024).toFixed(2)}KB)`);
                    }
                } catch (cacheError) {
                    if (cacheError.name === 'QuotaExceededError') {
                        console.warn('LocalStorage quota exceeded. Skipping cache. Data will still be displayed.');
                        // Try to clear old cache
                        try {
                            localStorage.removeItem(cacheKey);
                            localStorage.removeItem(cacheTimestampKey);
                            // Try again with smaller data
                            const dataString = JSON.stringify(data);
                            if (new Blob([dataString]).size < 2 * 1024 * 1024) { // Only if < 2MB
                                localStorage.setItem(cacheKey, dataString);
                                localStorage.setItem(cacheTimestampKey, Date.now().toString());
                            }
                        } catch (e) {
                            console.warn('Could not free up cache space:', e);
                        }
                    } else {
                        console.warn('Error caching data:', cacheError);
                    }
                    // Continue processing even if cache fails
                }
            }
            
            this.processData(data);
        } catch (error) {
            console.error('Error fetching data:', error);
            if (error.name === 'QuotaExceededError') {
                alert('ข้อมูลมีขนาดใหญ่เกินไปสำหรับเก็บใน Cache\nข้อมูลจะยังแสดงได้ปกติ แต่จะไม่ถูกเก็บไว้ใน Cache');
            } else {
                alert('เกิดข้อผิดพลาดในการดึงข้อมูล: ' + error.message);
            }
            this.hideLoading();
        }
    }

    processData(data) {
        // Process data using Web Worker for parallel processing
        if (this.worker) {
            this.worker.postMessage({
                type: 'process_data',
                data: data
            });
        } else {
            // Fallback to main thread if workers not supported
            this.allData = this.processDataSync(data);
            this.updateSubdistrictList();
            this.updateVictimTypesList();
            this.applyFilters();
            this.hideLoading();
        }
    }

    processDataSync(data) {
        // Synchronous processing fallback
        const items = data?.data?.data || [];
        return items.map(item => ({
            id: item._id,
            runningNumber: item.running_number,
            coordinates: item.location?.geometry?.coordinates || null,
            province: item.location?.properties?.province || '',
            district: item.location?.properties?.district || '',
            subdistrict: item.location?.properties?.subdistrict || '',
            status: item.location?.properties?.status,
            statusText: item.location?.properties?.status_text || '',
            type: item.location?.properties?.type,
            typeName: item.location?.properties?.type_name || '',
            victims: item.location?.properties?.victims || [],
            other: item.location?.properties?.other || '',
            ages: item.location?.properties?.ages || '',
            disease: item.location?.properties?.disease || '',
            patient: item.location?.properties?.patient || 0,
            created_at: item.created_at,
            updated_at: item.updated_at
        })).filter(item => item.coordinates && item.coordinates.length === 2);
    }

    debouncedApplyFilters() {
        // Clear existing timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        // Set new timer (300ms debounce)
        this.debounceTimer = setTimeout(() => {
            this.applyFilters();
        }, 300);
    }

    applyFilters() {
        // Get filter values
        const selectedStatuses = Array.from(document.querySelectorAll('input[name="status"]:checked'))
            .map(cb => parseInt(cb.value));
        
        const selectedVictims = Array.from(document.querySelectorAll('input[name="victims"]:checked'))
            .map(cb => cb.value);
        
        // Get victim filter mode (any = OR, all = AND)
        const victimFilterMode = document.querySelector('input[name="victimFilterMode"]:checked')?.value || 'any';
        
        const subdistrictFilter = document.getElementById('subdistrictFilter');
        const selectedSubdistrict = subdistrictFilter.value;
        
        // Filter data
        this.filteredData = this.allData.filter(item => {
            // Status filter
            if (!selectedStatuses.includes(item.status)) {
                return false;
            }
            
            // Victims filter with mode selection
            if (selectedVictims.length === 0) {
                // ถ้าไม่เลือกอะไรเลย (ล้างทั้งหมด) → ไม่แสดงข้อมูล
                return false;
            } else {
                const itemVictims = item.victims || [];
                
                if (victimFilterMode === 'all') {
                    // เจาะจง: ต้องตรงกับทุกประเภทที่เลือก (AND logic)
                    // กรณีพิเศษ: ถ้าเลือก "ทั่วไป" ต้องไม่มี victims อื่นเลย
                    if (selectedVictims.includes('ทั่วไป')) {
                        if (selectedVictims.length === 1) {
                            // เลือกเฉพาะ "ทั่วไป" → ต้องไม่มี victims อื่นเลย
                            if (itemVictims.length > 0) {
                                return false;
                            }
                        } else {
                            // เลือก "ทั่วไป" + ประเภทอื่น → ไม่ควรเกิดขึ้น (กรองออก)
                            return false;
                        }
                    } else {
                        // ไม่เลือก "ทั่วไป" → ตรวจสอบว่าทุกประเภทที่เลือกมีอยู่ใน item.victims
                        const allSelectedPresent = selectedVictims.every(selected => 
                            itemVictims.includes(selected)
                        );
                        
                        if (!allSelectedPresent) {
                            return false;
                        }
                        
                        // ต้องไม่มีประเภทอื่นนอกเหนือจากที่เลือก
                        const hasOtherTypes = itemVictims.some(victim => 
                            !selectedVictims.includes(victim)
                        );
                        
                        if (hasOtherTypes) {
                            return false;
                        }
                    }
                } else {
                    // รวม: แสดงที่ตรงกับอย่างน้อย 1 ประเภท (OR logic) - โหมดเดิม
                    const hasMatchingVictim = itemVictims.some(victim => selectedVictims.includes(victim));
                    
                    if (!hasMatchingVictim && itemVictims.length > 0) {
                        return false;
                    }
                    
                    // If item has no victims array but we're filtering, include it if "ทั่วไป" is selected
                    if (itemVictims.length === 0 && !selectedVictims.includes('ทั่วไป')) {
                        return false;
                    }
                }
            }
            
            // Subdistrict filter
            if (selectedSubdistrict && selectedSubdistrict !== 'all') {
                if (item.subdistrict !== selectedSubdistrict) {
                    return false;
                }
            }
            
            return true;
        });
        
        // Update statistics first (fast)
        this.updateStatistics();
        
        // Update map markers (with progressive rendering)
        this.updateMapMarkersProgressive();
        
        // Update notes panel
        this.updateNotesPanel();
    }

    updateMapMarkersProgressive() {
        // Cancel any ongoing rendering
        if (this.isRendering) {
            this.isRendering = false;
        }
        
        // Clear existing markers and cluster group
        if (this.markerClusterGroup) {
            this.map.removeLayer(this.markerClusterGroup);
        }
        this.markers = [];
        
        const dataToRender = this.filteredData.filter(item => 
            item.coordinates && item.coordinates.length === 2
        );
        
        if (dataToRender.length === 0) {
            return;
        }
        
        // Show progress for large datasets
        const showProgress = dataToRender.length > 500;
        if (showProgress) {
            this.showProgress(0);
        }
        
        // Initialize marker cluster group
        this.markerClusterGroup = L.markerClusterGroup({
            chunkedLoading: true,
            chunkDelay: 50,
            maxClusterRadius: 50,
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
            zoomToBoundsOnClick: true
        });
        
        // Render markers progressively
        this.isRendering = true;
        this.renderMarkersProgressive(dataToRender, 0, showProgress);
    }
    
    renderMarkersProgressive(data, startIndex, showProgress) {
        if (!this.isRendering) {
            return;
        }
        
        const batchSize = 100; // Render 100 markers per batch
        const endIndex = Math.min(startIndex + batchSize, data.length);
        
        // Create markers for this batch
        for (let i = startIndex; i < endIndex; i++) {
            if (!this.isRendering) break;
            
            const item = data[i];
            const [lng, lat] = item.coordinates;
            
            // Create custom icon based on status
            const iconColor = item.status === 0 ? '#ffc107' : '#17a2b8';
            const icon = L.divIcon({
                className: 'custom-marker',
                html: `<div style="
                    width: 20px;
                    height: 20px;
                    background: ${iconColor};
                    border: 2px solid white;
                    border-radius: 50%;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                "></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            
            // Create popup content (lazy - only create when needed)
            const popupContent = this.createPopupContent(item);
            
                // Create marker with itemId for reference
                const marker = L.marker([lat, lng], { 
                    icon,
                    itemId: item.id
                })
                    .bindPopup(popupContent);
            
            this.markers.push(marker);
            this.markerClusterGroup.addLayer(marker);
        }
        
        // Add cluster group to map if first batch
        if (startIndex === 0) {
            this.markerClusterGroup.addTo(this.map);
        }
        
        // Update progress
        if (showProgress) {
            const progress = (endIndex / data.length) * 100;
            this.updateProgress(progress);
        }
        
        // Continue with next batch or finish
        if (endIndex < data.length) {
            // Use requestAnimationFrame for smooth rendering
            requestAnimationFrame(() => {
                this.renderMarkersProgressive(data, endIndex, showProgress);
            });
        } else {
            // Finished rendering
            this.isRendering = false;
            if (showProgress) {
                this.hideProgress();
            }
            
            // Fit bounds to show all markers (only if not too many)
            if (data.length < 1000) {
                try {
                    const bounds = this.markerClusterGroup.getBounds();
                    if (bounds.isValid()) {
                        this.map.fitBounds(bounds, { padding: [50, 50] });
                    }
                } catch (e) {
                    console.warn('Could not fit bounds:', e);
                }
            }
        }
    }
    
    showProgress(initialPercent = 0) {
        const progressBar = document.getElementById('progressBar');
        const progressFill = document.getElementById('progressFill');
        if (progressBar && progressFill) {
            progressBar.style.display = 'block';
            progressFill.style.width = initialPercent + '%';
        }
    }
    
    updateProgress(percent) {
        const progressFill = document.getElementById('progressFill');
        const loadingText = document.getElementById('loadingText');
        if (progressFill) {
            progressFill.style.width = percent + '%';
        }
        if (loadingText) {
            loadingText.textContent = `กำลังแสดงข้อมูล... ${Math.round(percent)}%`;
        }
    }
    
    hideProgress() {
        const progressBar = document.getElementById('progressBar');
        const loadingText = document.getElementById('loadingText');
        if (progressBar) {
            progressBar.style.display = 'none';
        }
        if (loadingText) {
            loadingText.textContent = 'กำลังโหลดข้อมูล...';
        }
    }

    createPopupContent(item) {
        let content = `<div class="popup-title">${item.runningNumber || item.id}</div>`;
        
        content += `<div class="popup-info"><strong>ประเภท:</strong> ${item.typeName || 'ไม่ระบุ'}</div>`;
        content += `<div class="popup-info"><strong>สถานะ:</strong> <span class="popup-status status-${item.status}">${item.statusText}</span></div>`;
        
        if (item.province) {
            content += `<div class="popup-info"><strong>ที่อยู่:</strong> ${item.subdistrict}, ${item.district}, ${item.province}</div>`;
        }
        
        if (item.victims && item.victims.length > 0) {
            content += `<div class="popup-victims"><strong>ผู้ประสบภัย:</strong> `;
            content += item.victims.map(v => `<span>${v}</span>`).join('');
            content += `</div>`;
        }
        
        if (item.ages) {
            content += `<div class="popup-info"><strong>อายุ:</strong> ${item.ages}</div>`;
        }
        
        if (item.disease) {
            content += `<div class="popup-info"><strong>โรคประจำตัว:</strong> ${item.disease}</div>`;
        }
        
        if (item.other) {
            content += `<div class="popup-info"><strong>หมายเหตุ:</strong> ${item.other.substring(0, 100)}${item.other.length > 100 ? '...' : ''}</div>`;
        }
        
        if (item.updated_at) {
            const updateDate = new Date(item.updated_at);
            content += `<div class="popup-info"><strong>อัปเดต:</strong> ${updateDate.toLocaleString('th-TH')}</div>`;
        }
        
        return content;
    }

    updateStatistics() {
        const total = this.allData.length;
        const filtered = this.filteredData.length;
        const status0 = this.filteredData.filter(item => item.status === 0).length;
        const status3 = this.filteredData.filter(item => item.status === 3).length;
        
        document.getElementById('totalCount').textContent = total;
        document.getElementById('filteredCount').textContent = filtered;
        document.getElementById('status0Count').textContent = status0;
        document.getElementById('status3Count').textContent = status3;
    }

    getAllVictimTypes() {
        // ลำดับความสำคัญของประเภทผู้ประสบภัย
        const priorityOrder = [
            'ผู้ป่วยติดเตียง',
            'ผู้ป่วยติดบ้าน',
            'เด็ก',
            'ผู้สูงอายุ',
            'คนพิการ',
            'ทั่วไป',
            'สัตว์เลี้ยง'
        ];
        
        // ดึงประเภทผู้ประสบภัยทั้งหมดจากข้อมูล
        const allTypes = new Set();
        this.allData.forEach(item => {
            if (item.victims && Array.isArray(item.victims)) {
                item.victims.forEach(victim => {
                    if (victim && victim.trim()) {
                        // ทำความสะอาดข้อมูล - ลบ "^" และ whitespace
                        const cleaned = victim.trim().replace(/\^/g, '');
                        
                        // ข้ามข้อมูลที่ผิดปกติ (มี "^" มากเกินไป หรือเป็น empty หลังทำความสะอาด)
                        if (cleaned.length === 0 || cleaned.length < 2) {
                            return;
                        }
                        
                        // ข้ามข้อมูลที่ยังมี "^" อยู่ (แสดงว่ามีปัญหา)
                        if (victim.includes('^')) {
                            return;
                        }
                        
                        allTypes.add(cleaned);
                    }
                });
            }
        });
        
        const typesArray = Array.from(allTypes);
        
        // เรียงตาม priority order
        return typesArray.sort((a, b) => {
            const indexA = priorityOrder.indexOf(a);
            const indexB = priorityOrder.indexOf(b);
            
            // ถ้าอยู่ใน priority order ให้เรียงตามนั้น
            if (indexA !== -1 && indexB !== -1) {
                return indexA - indexB;
            }
            // ถ้าไม่เจอใน priority order ให้เรียงตามตัวอักษร (ภาษาไทย)
            if (indexA === -1 && indexB === -1) {
                return a.localeCompare(b, 'th');
            }
            // ประเภทที่อยู่ใน priority order มาก่อน
            return indexA === -1 ? 1 : -1;
        });
    }
    
    getVictimTypeIcon(victimType) {
        // Mapping icon สำหรับแต่ละประเภท
        const iconMap = {
            'เด็ก': '👶',
            'ผู้สูงอายุ': '👴',
            'คนพิการ': '♿',
            'ทั่วไป': '👤',
            'ผู้ป่วยติดบ้าน': '🏠',
            'ผู้ป่วยติดเตียง': '🛏️',
            'สัตว์เลี้ยง': '🐾'
        };
        return iconMap[victimType] || '📋';
    }
    
    updateVictimTypesList() {
        const victimTypes = this.getAllVictimTypes();
        const container = document.getElementById('victimTypesList');
        
        if (!container) return;
        
        // เก็บค่าที่เลือกไว้ก่อน
        const selectedValues = Array.from(document.querySelectorAll('input[name="victims"]:checked'))
            .map(cb => cb.value);
        
        // Clear container
        container.innerHTML = '';
        
        if (victimTypes.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #6c757d; padding: 10px;">ไม่มีข้อมูลประเภทผู้ประสบภัย</div>';
            return;
        }
        
        // สร้าง checkbox สำหรับแต่ละประเภท
        victimTypes.forEach(victimType => {
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = 'victims';
            checkbox.value = victimType;
            checkbox.checked = selectedValues.length === 0 || selectedValues.includes(victimType);
            
            const icon = this.getVictimTypeIcon(victimType);
            const span = document.createElement('span');
            span.textContent = `${icon} ${victimType}`;
            
            label.appendChild(checkbox);
            label.appendChild(span);
            container.appendChild(label);
        });
        
        // Re-attach event listeners
        document.querySelectorAll('input[name="victims"]').forEach(checkbox => {
            checkbox.addEventListener('change', () => this.debouncedApplyFilters());
        });
    }
    
    checkAllVictims(check) {
        // เลือกหรือยกเลิกการเลือกทั้งหมด
        document.querySelectorAll('input[name="victims"]').forEach(checkbox => {
            checkbox.checked = check;
        });
        // Apply filters after changing
        this.debouncedApplyFilters();
    }
    
    updateSubdistrictList() {
        // นับความถี่ของแต่ละตำบล
        const subdistrictCount = {};
        this.allData.forEach(item => {
            if (item.subdistrict) {
                subdistrictCount[item.subdistrict] = (subdistrictCount[item.subdistrict] || 0) + 1;
            }
        });
        
        // แปลงเป็น array และเรียงตามความถี่ (จากมากไปน้อย)
        const subdistricts = Object.keys(subdistrictCount)
            .sort((a, b) => subdistrictCount[b] - subdistrictCount[a]);
        
        const select = document.getElementById('subdistrictFilter');
        
        // เก็บค่าที่เลือกไว้ก่อน
        const selectedValue = select.value;
        
        // Clear existing options except "all"
        select.innerHTML = '<option value="all">ทั้งหมด</option>';
        
        // Add subdistricts with count
        subdistricts.forEach(subdistrict => {
            const option = document.createElement('option');
            option.value = subdistrict;
            option.textContent = `${subdistrict} (${subdistrictCount[subdistrict]})`;
            // Restore selection if it was selected before
            if (selectedValue === subdistrict) {
                option.selected = true;
            }
            select.appendChild(option);
        });
        
        // Restore "all" selection if it was selected
        if (selectedValue === 'all' || !selectedValue) {
            select.value = 'all';
        }
    }
    
    zoomToSubdistrict(subdistrict) {
        // หาข้อมูลทั้งหมดของตำบลนี้
        const subdistrictData = this.allData.filter(item => 
            item.subdistrict === subdistrict && 
            item.coordinates && 
            item.coordinates.length === 2
        );
        
        if (subdistrictData.length === 0) {
            return;
        }
        
        // คำนวณ bounds
        const bounds = [];
        subdistrictData.forEach(item => {
            const [lng, lat] = item.coordinates;
            bounds.push([lat, lng]);
        });
        
        if (bounds.length > 0) {
            // สร้าง bounds object
            const latlngBounds = L.latLngBounds(bounds);
            
            // เพิ่ม padding รอบๆ เพื่อให้เห็นบริเวณโดยรอบ
            // คำนวณ padding ตามจำนวนข้อมูล
            const padding = subdistrictData.length > 50 ? 100 : 150;
            
            // Zoom to bounds with padding
            this.map.fitBounds(latlngBounds, {
                padding: [padding, padding],
                maxZoom: 15 // จำกัด max zoom เพื่อไม่ให้ zoom ใกล้เกินไป
            });
        }
    }

    showLoading() {
        const indicator = document.getElementById('loadingIndicator');
        if (indicator) {
            indicator.style.display = 'block';
        }
    }

    hideLoading() {
        const indicator = document.getElementById('loadingIndicator');
        if (indicator) {
            indicator.style.display = 'none';
        }
        this.hideProgress();
    }
    
    changeMapStyle(styleName) {
        if (!this.map || !this.baseMaps[styleName]) {
            return;
        }
        
        // ลบ layer ทั้งหมด
        this.map.eachLayer((layer) => {
            if (layer instanceof L.TileLayer) {
                this.map.removeLayer(layer);
            }
        });
        
        // เพิ่ม layer ใหม่
        this.baseMaps[styleName].addTo(this.map);
        
        // บันทึกการตั้งค่า
        localStorage.setItem('map_style', styleName);
        
        console.log('Changed map style to:', styleName);
    }
    
    startAutoRefresh() {
        // หยุด auto-refresh เดิมถ้ามี
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
        }
        
        // ตั้งค่า auto-refresh ทุก 5 นาที
        const intervalMs = this.autoRefreshMinutes * 60 * 1000;
        this.autoRefreshInterval = setInterval(() => {
            this.checkForUpdates();
        }, intervalMs);
        
        console.log(`Auto-refresh enabled: every ${this.autoRefreshMinutes} minutes`);
        this.updateAutoRefreshStatus();
    }
    
    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }
        this.updateAutoRefreshStatus();
    }
    
    async checkForUpdates() {
        try {
            // Fetch เพื่อตรวจสอบ fetched_at
            const response = await fetch(this.apiUrl);
            if (!response.ok) {
                console.warn('Failed to check for updates');
                return;
            }
            
            const data = await response.json();
            const newFetchedAt = data.fetched_at;
            
            // ตรวจสอบว่ามีข้อมูลใหม่หรือไม่
            if (this.lastFetchedAt && newFetchedAt && newFetchedAt !== this.lastFetchedAt) {
                // มีข้อมูลใหม่ - แสดง notification และ refresh
                this.showUpdateNotification();
                this.loadData(true); // force refresh
            } else if (!this.lastFetchedAt && newFetchedAt) {
                // ครั้งแรก - เก็บค่า
                this.lastFetchedAt = newFetchedAt;
            } else {
                // ไม่มีข้อมูลใหม่ แต่ยัง refresh เพื่อให้ข้อมูลเป็นปัจจุบัน
                this.loadData(true);
            }
        } catch (error) {
            console.error('Error checking for updates:', error);
        }
    }
    
    showUpdateNotification() {
        // สร้าง notification element
        const notification = document.createElement('div');
        notification.className = 'update-notification';
        notification.innerHTML = `
            <div style="background: #28a745; color: white; padding: 12px 18px; 
                        border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                        position: fixed; top: 20px; right: 20px; z-index: 10000;
                        animation: slideInRight 0.3s ease-out; min-width: 250px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 1.5rem;">🔄</span>
                    <div>
                        <strong style="display: block; margin-bottom: 4px;">มีข้อมูลใหม่!</strong>
                        <span style="font-size: 0.85rem; opacity: 0.9;">กำลังอัปเดตข้อมูล...</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(notification);
        
        // ลบ notification หลังจาก 4 วินาที
        setTimeout(() => {
            notification.style.animation = 'slideOutRight 0.3s ease-out';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }, 4000);
    }
    
    updateLastUpdateDisplay() {
        const lastUpdateEl = document.getElementById('lastUpdateTime');
        if (lastUpdateEl && this.lastUpdateTime) {
            const timeStr = this.lastUpdateTime.toLocaleString('th-TH', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            lastUpdateEl.textContent = `อัปเดตล่าสุด: ${timeStr}`;
        }
    }
    
    updateAutoRefreshStatus() {
        const statusEl = document.getElementById('autoRefreshStatus');
        if (statusEl) {
            if (this.autoRefreshInterval) {
                statusEl.innerHTML = `<span style="color: #28a745;">🔄 เปิดใช้งาน</span> (ทุก ${this.autoRefreshMinutes} นาที)`;
            } else {
                statusEl.innerHTML = `<span style="color: #6c757d;">⏸️ ปิดใช้งาน</span>`;
            }
        }
    }
}

// Initialize app when DOM is ready and Leaflet is loaded
function initializeApp() {
    // Wait for Leaflet to be available
    if (typeof L === 'undefined') {
        console.warn('Waiting for Leaflet to load...');
        setTimeout(initializeApp, 100);
        return;
    }
    
    try {
        const app = new FloodMapApp();
        window.floodMapApp = app;
        
        // Override worker message handler to also update subdistrict and victim types list
        if (app.worker) {
            const originalOnMessage = app.worker.onmessage.bind(app.worker);
            app.worker.onmessage = (e) => {
                originalOnMessage(e);
                if (e.data.type === 'data_processed') {
                    app.updateSubdistrictList();
                    app.updateVictimTypesList();
                }
            };
        }
        
        // Override processDataSync to update subdistrict and victim types list
        const originalProcessDataSync = app.processDataSync.bind(app);
        app.processDataSync = function(data) {
            const result = originalProcessDataSync(data);
            setTimeout(() => {
                this.updateSubdistrictList();
                this.updateVictimTypesList();
            }, 100);
            return result;
        };
    } catch (error) {
        console.error('Error initializing app:', error);
        document.getElementById('map').innerHTML = 
            '<div style="padding: 20px; text-align: center; color: red;">' +
            '<h3>⚠️ เกิดข้อผิดพลาดในการเริ่มต้นแอปพลิเคชัน</h3>' +
            '<p>' + error.message + '</p>' +
            '</div>';
    }
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM is already ready
    initializeApp();
}

