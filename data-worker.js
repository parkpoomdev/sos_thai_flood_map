// Web Worker for parallel data processing
// This worker processes SOS flood data in a separate thread to avoid blocking the main UI

self.onmessage = function(e) {
    const { type, data } = e.data;
    
    if (type === 'process_data') {
        try {
            const processedData = processDataParallel(data);
            self.postMessage({
                type: 'data_processed',
                data: processedData
            });
        } catch (error) {
            self.postMessage({
                type: 'error',
                data: error.message
            });
        }
    }
};

function processDataParallel(data) {
    // Extract items array
    const items = data?.data?.data || [];
    
    if (items.length === 0) {
        return [];
    }
    
    // Process items in parallel using chunking
    const chunkSize = Math.ceil(items.length / 4); // Divide into 4 chunks
    const chunks = [];
    
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    
    // Process each chunk
    const processedChunks = chunks.map(chunk => 
        chunk.map(processItem).filter(item => item !== null)
    );
    
    // Flatten results
    return processedChunks.flat();
}

function processItem(item) {
    try {
        // Validate coordinates
        const coordinates = item.location?.geometry?.coordinates;
        if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
            return null;
        }
        
        // Validate coordinates are numbers
        const [lng, lat] = coordinates;
        if (typeof lng !== 'number' || typeof lat !== 'number') {
            return null;
        }
        
        // Validate coordinates are within reasonable bounds (Thailand)
        if (lng < 97 || lng > 106 || lat < 5 || lat > 21) {
            return null;
        }
        
        // Extract and process data
        const properties = item.location?.properties || {};
        
        return {
            id: item._id || null,
            runningNumber: item.running_number || null,
            coordinates: coordinates,
            province: properties.province || '',
            district: properties.district || '',
            subdistrict: properties.subdistrict || '',
            status: typeof properties.status === 'number' ? properties.status : null,
            statusText: properties.status_text || '',
            type: properties.type || null,
            typeName: properties.type_name || '',
            victims: Array.isArray(properties.victims) ? properties.victims : [],
            other: properties.other || '',
            ages: properties.ages || '',
            disease: properties.disease || '',
            patient: properties.patient || 0,
            medicStatus: properties.medic_status || null,
            medicStatusText: properties.medic_status_text || '',
            sickLevelSummary: properties.sick_level_summary || null,
            created_at: item.created_at || null,
            updated_at: item.updated_at || null
        };
    } catch (error) {
        console.error('Error processing item:', error, item);
        return null;
    }
}

// Handle errors
self.onerror = function(error) {
    self.postMessage({
        type: 'error',
        data: error.message || 'Unknown error in worker'
    });
};

