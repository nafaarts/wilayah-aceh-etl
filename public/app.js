const map = L.map('map', { zoomControl: false }).setView([4.695135, 96.7493993], 8); // Default view Aceh

// Custom Zoom Control Position
L.control.zoom({
    position: 'bottomright'
}).addTo(map);

// Base Layers
const baseLayers = {
    "Google Satellite": L.tileLayer('http://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: 'Map data &copy; <a href="https://www.google.com">Google Maps</a>'
    }),
    "Google Streets": L.tileLayer('http://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: 'Map data &copy; <a href="https://www.google.com">Google Maps</a>'
    }),
    "Google Hybrid": L.tileLayer('http://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: 'Map data &copy; <a href="https://www.google.com">Google Maps</a>'
    }),
    "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    })
};

// Set Default Base Layer
baseLayers["Google Satellite"].addTo(map);

// Layer Groups
const layers = {
    provinsi: L.layerGroup(),
    kabupaten: L.layerGroup(),
    kecamatan: L.layerGroup(),
    kelurahan: L.layerGroup()
};

// Add Layer Control
let layerControl = L.control.layers(baseLayers, {
    "Provinsi": layers.provinsi,
    "Kabupaten": layers.kabupaten,
    "Kecamatan": layers.kecamatan,
    "Kelurahan": layers.kelurahan
}, { collapsed: false }).addTo(map);

let currentCode = '';

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');

    sidebar.classList.toggle('hidden');

    if (sidebar.classList.contains('hidden')) {
        toggleBtn.style.display = 'flex';
    } else {
        toggleBtn.style.display = 'none';
    }

    // Trigger resize map to ensure tiles load correctly if layout changes affecting map size
    // In this case map is absolute 100% so it might not need resize, but good practice
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
}

async function checkStatus() {
    const code = document.getElementById('code').value.trim();
    if (!code) {
        alert('Masukkan kode wilayah!');
        return;
    }
    currentCode = code;

    document.getElementById('db-status').style.display = 'flex';
    const infoDiv = document.getElementById('db-info');
    const btnSync = document.getElementById('btn-sync');
    const btnPreview = document.getElementById('btn-preview');
    // Add Preview File button if not exists
    let btnPreviewFile = document.getElementById('btn-preview-file');
    if (!btnPreviewFile) {
        btnPreviewFile = document.createElement('button');
        btnPreviewFile.id = 'btn-preview-file';
        btnPreviewFile.className = 'btn btn-info';
        btnPreviewFile.style.flex = '1';
        btnPreviewFile.textContent = 'Preview File';
        btnPreviewFile.onclick = () => loadData(false);
        // Insert after btnPreview
        btnPreview.parentNode.appendChild(btnPreviewFile);
    }

    const statusDiv = document.getElementById('status');

    statusDiv.textContent = 'Mengecek database...';
    infoDiv.innerHTML = '';
    btnSync.style.display = 'none';
    btnPreview.style.display = 'none';
    btnPreviewFile.style.display = 'none';
    document.getElementById('sync-progress').style.display = 'none';

    try {
        const response = await fetch(`/api/db/status?code=${code}`);
        const stats = await response.json();

        if (stats.error && stats.error === "Database not connected") {
            infoDiv.innerHTML = `<span style="color:red">Database Error: ${stats.error}. Menggunakan mode file lokal.</span>`;
            loadData(false);
            return;
        }

        if (stats.available) {
            infoDiv.innerHTML = `
                <strong>Data Tersedia di Database:</strong><br>
                ${stats.provinsi ? `Provinsi: ${stats.provinsi}<br>` : ''}
                Kabupaten: ${stats.kabupaten}<br>
                Kecamatan: ${stats.kecamatan}<br>
                Kelurahan: ${stats.kelurahan}
            `;
            btnPreview.style.display = 'inline-block';
            statusDiv.textContent = 'Data ditemukan di database.';
        } else {
            infoDiv.textContent = 'Data belum ada di database.';
            btnSync.style.display = 'inline-block';

            if (stats.fileAvailable) {
                btnPreviewFile.style.display = 'inline-block';
                statusDiv.textContent = 'Data tersedia di file GeoJSON (Belum di-sync).';
            } else {
                statusDiv.textContent = 'Silakan sync data ke database (File tidak ditemukan?).';
            }
        }

    } catch (error) {
        console.error(error);
        statusDiv.textContent = 'Gagal mengecek status DB.';
    }
}

async function syncData() {
    const code = currentCode;
    const btn = document.getElementById('btn-sync');
    const progressDiv = document.getElementById('sync-progress');
    const progressBar = document.getElementById('progress-bar');

    if (!confirm(`Yakin ingin sinkronisasi data untuk kode ${code}? Proses ini mungkin memakan waktu.`)) return;

    btn.disabled = true;
    progressDiv.style.display = 'block';
    progressBar.style.width = '10%';

    try {
        const res = await fetch('/api/db/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });

        progressBar.style.width = '80%';
        const data = await res.json();

        if (data.success) {
            progressBar.style.width = '100%';
            alert(`Sync berhasil! ${data.processed} area diproses.`);
            checkStatus();
        } else {
            alert('Sync gagal: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    } finally {
        btn.disabled = false;
        setTimeout(() => {
            progressDiv.style.display = 'none';
            progressBar.style.width = '0%';
        }, 2000);
    }
}

async function loadDataFromDB() {
    loadData(true);
}

async function loadData(useDB = false) {
    const code = document.getElementById('code').value.trim();
    const statusDiv = document.getElementById('status');

    if (!code) {
        alert('Masukkan kode wilayah!');
        return;
    }

    statusDiv.textContent = 'Memuat data...';

    // Clear existing layers
    layers.provinsi.clearLayers();
    layers.kabupaten.clearLayers();
    layers.kecamatan.clearLayers();
    layers.kelurahan.clearLayers();

    // Reset Map Layers
    if (!map.hasLayer(layers.provinsi)) map.addLayer(layers.provinsi);
    if (!map.hasLayer(layers.kabupaten)) map.addLayer(layers.kabupaten);
    if (!map.hasLayer(layers.kecamatan)) map.addLayer(layers.kecamatan);
    if (!map.hasLayer(layers.kelurahan)) map.addLayer(layers.kelurahan);

    try {
        const url = useDB ? `/api/db/geojson?code=${code}` : `/api/geojson?code=${code}`;
        const response = await fetch(url);

        if (response.status === 404) {
            statusDiv.textContent = 'Data tidak ditemukan.';
            return;
        }
        if (!response.ok) throw new Error(`Error: ${response.statusText}`);

        const data = await response.json();
        let bounds = L.latLngBounds([]);
        let hasData = false;

        // Helper to add data
        const addDataToLayer = (geoJson, layerGroup, style, onFeature) => {
            if (!geoJson) return;
            const layer = L.geoJSON(geoJson, {
                style: style,
                onEachFeature: (feature, l) => {
                    if (feature.properties) {
                        l.bindPopup(`
                            <div style="min-width: 200px;">
                                <strong>${feature.properties.name || ''}</strong><br>
                                <span style="font-size: 12px; color: #666; margin-top: 5px;">${feature.properties.id || ''}</span>
                            </div>`);
                        l.bindTooltip(feature.properties.name || '', { permanent: false, direction: "center" });
                    }
                    if (onFeature) onFeature(feature, l);
                }
            });
            layer.addTo(layerGroup);
            try {
                bounds.extend(layer.getBounds());
                hasData = true;
            } catch (e) { }
        };

        const formatSize = (bytes) => {
            if (!bytes) return '';
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        // Render Layers
        const newOverlayLayers = {};
        const codeLen = code.replace(/\./g, '').length; // Clean length check if code has dots

        // Logic: Show target level and children. Hide parents.
        // Lengths: Prov=2, Kab=5(or 4 if raw), Kec=8, Kel=13 (approx)
        // Standard code length with dots: 2 (11), 5 (11.01), 8 (11.01.01), 13 (11.01.01.2001)

        // 1. PROVINSI (Length <= 2) -> Show Prov + Kab
        if (code.length <= 2) {
            if (data.provinsi && data.provinsi.data) {
                addDataToLayer(data.provinsi.data, layers.provinsi, {
                    color: '#000000', weight: 5, opacity: 1, fillOpacity: 0
                });
                newOverlayLayers[`Provinsi${data.provinsi.size ? ', ' + formatSize(data.provinsi.size) : ''}`] = layers.provinsi;
            }
            if (data.kabupaten && data.kabupaten.data) {
                addDataToLayer(data.kabupaten.data, layers.kabupaten, {
                    color: '#ff0000', weight: 2, opacity: 1, fillOpacity: 0.1
                });
                newOverlayLayers[`Kabupaten${data.kabupaten.size ? ', ' + formatSize(data.kabupaten.size) : ''}`] = layers.kabupaten;
            }
        }

        // 2. KABUPATEN (Length 5) -> Show Kab + Kec + Kel. Hide Prov.
        else if (code.length === 5) {
            if (data.kabupaten && data.kabupaten.data) {
                addDataToLayer(data.kabupaten.data, layers.kabupaten, {
                    color: '#ff0000', weight: 3, opacity: 1, fillOpacity: 0
                });
                newOverlayLayers[`Kabupaten${data.kabupaten.size ? ', ' + formatSize(data.kabupaten.size) : ''}`] = layers.kabupaten;
            }
            if (data.kecamatan && data.kecamatan.data) {
                addDataToLayer(data.kecamatan.data, layers.kecamatan, {
                    color: '#0000ff', weight: 1, opacity: 1, fillOpacity: 0.1
                });
                newOverlayLayers[`Kecamatan${data.kecamatan.size ? ', ' + formatSize(data.kecamatan.size) : ''}`] = layers.kecamatan;
            }
            if (data.kelurahan && data.kelurahan.data) {
                addDataToLayer(data.kelurahan.data, layers.kelurahan, {
                    color: '#388e3c', weight: 1, opacity: 1, fillColor: '#388e3c', fillOpacity: 0.2
                });
                newOverlayLayers[`Kelurahan${data.kelurahan.size ? ', ' + formatSize(data.kelurahan.size) : ''}`] = layers.kelurahan;
            }
        }

        // 3. KECAMATAN (Length 8) -> Show Kec + Kel. Hide Kab, Prov.
        else if (code.length === 8) {
            if (data.kecamatan && data.kecamatan.data) {
                addDataToLayer(data.kecamatan.data, layers.kecamatan, {
                    color: '#0000ff', weight: 3, opacity: 1, fillOpacity: 0
                });
                newOverlayLayers[`Kecamatan${data.kecamatan.size ? ', ' + formatSize(data.kecamatan.size) : ''}`] = layers.kecamatan;
            }
            if (data.kelurahan && data.kelurahan.data) {
                addDataToLayer(data.kelurahan.data, layers.kelurahan, {
                    color: '#388e3c', weight: 1, opacity: 1, fillColor: '#388e3c', fillOpacity: 0.2
                });
                newOverlayLayers[`Kelurahan${data.kelurahan.size ? ', ' + formatSize(data.kelurahan.size) : ''}`] = layers.kelurahan;
            }
        }

        // 4. KELURAHAN (Length > 8) -> Show Kel only. Hide Kec, Kab, Prov.
        else if (code.length > 8) {
            if (data.kelurahan && data.kelurahan.data) {
                addDataToLayer(data.kelurahan.data, layers.kelurahan, {
                    color: '#388e3c', weight: 2, opacity: 1, fillColor: '#388e3c', fillOpacity: 0.4
                });
                newOverlayLayers[`Kelurahan${data.kelurahan.size ? ', ' + formatSize(data.kelurahan.size) : ''}`] = layers.kelurahan;
            }
        }

        // Fallback: If no strict match logic hit, try to render whatever is available (shouldn't happen with valid codes)
        // But to be safe, if newOverlayLayers is empty, we might want to check data existence.
        // However, the above logic covers standard cases.

        // Update Layer Control
        if (layerControl) map.removeControl(layerControl);
        layerControl = L.control.layers(baseLayers, newOverlayLayers, { collapsed: false }).addTo(map);

        // Fit Bounds
        if (hasData && bounds.isValid()) {
            map.flyToBounds(bounds, { duration: 1.5 });
            const sourceInfo = useDB ? "Database (PostGIS)" : "File Lokal (GeoJSON)";
            statusDiv.textContent = `Data dimuat dari ${sourceInfo}.`;
        } else {
            statusDiv.textContent = 'Tidak ada data valid.';
        }

    } catch (error) {
        console.error(error);
        statusDiv.textContent = 'Gagal memuat data: ' + error.message;
    }
}

// --- Search Logic ---
const searchInput = document.getElementById('search');
const suggestionsBox = document.getElementById('suggestions');
let debounceTimer;

if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearTimeout(debounceTimer);

        if (query.length < 3) {
            suggestionsBox.style.display = 'none';
            return;
        }

        debounceTimer = setTimeout(() => {
            fetchSuggestions(query);
        }, 300);
    });
}

async function fetchSuggestions(query) {
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const results = await response.json();
        showSuggestions(results);
    } catch (error) {
        console.error('Search error:', error);
    }
}

function showSuggestions(results) {
    if (!suggestionsBox) return;
    suggestionsBox.innerHTML = '';
    if (results.length === 0) {
        suggestionsBox.style.display = 'none';
        return;
    }

    results.forEach(item => {
        const div = document.createElement('div');
        div.style.padding = '8px';
        div.style.cursor = 'pointer';
        div.style.borderBottom = '1px solid #eee';
        div.onmouseover = () => div.style.backgroundColor = '#f0f0f0';
        div.onmouseout = () => div.style.backgroundColor = 'white';

        let type = '';
        if (item.level === 1) type = 'Provinsi';
        if (item.level === 2) type = 'Kabupaten/Kota';
        if (item.level === 3) type = 'Kecamatan';
        if (item.level === 4) type = 'Kelurahan/Desa';

        div.innerHTML = `<strong>${item.name}</strong> <small style="color: #666">(${type})</small>`;

        div.onclick = async () => {
            const codeInput = document.getElementById('code');
            if (codeInput) codeInput.value = item.id;

            suggestionsBox.style.display = 'none';
            if (searchInput) searchInput.value = item.name;

            await checkStatus();

            const btnPreview = document.getElementById('btn-preview');
            if (btnPreview && btnPreview.style.display !== 'none') {
                loadDataFromDB();
            }
        };
        suggestionsBox.appendChild(div);
    });

    suggestionsBox.style.display = 'block';
}

document.addEventListener('click', (e) => {
    if (searchInput && suggestionsBox && !searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
        suggestionsBox.style.display = 'none';
    }
});
