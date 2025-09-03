import { VertexAI } from '@google-cloud/vertexai';

export const vertexAI = new VertexAI({
    project: process.env.GCLOUD_PROJECT,
    location: process.env.VERTEX_LOCATION || 'southamerica-east1',
});

export const normalizerModel = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
});