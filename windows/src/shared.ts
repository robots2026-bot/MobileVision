export interface TextMessage { id: string; text: string; source: string; state: string; createdAt: string; }
export interface ReceivedFile { direction?: string; id: string; name: string; bytes: number; offset: number; state: string; createdAt: string; receivedAt: string; }
export interface Photo { id: string; photoId: string; deviceName: string; receivedAt: string; capturedAt: string; bytes: number; width: number; height: number; filename: string; }
export interface DesktopState {
  directory: string; addresses: string[]; selectedAddress: string; port: number; running: boolean;
  pairing: { qr: string; expiresAt: number }; device: { name: string; lastSeen: number } | null;
  messages: TextMessage[]; filesDirectory: string; files: ReceivedFile[]; photos: Photo[]; error: string | null;
}
export interface CropRegion { x: number; y: number; width: number; height: number; }
export interface DesktopAPI {
  sendDroppedFiles(files: File[]): Promise<void>; pasteFiles(): Promise<void>;
  sendFiles(): Promise<void>; cancelSendFile(id: string): Promise<void>;
  chooseFilesDirectory(): Promise<void>; openFilesDirectory(): Promise<void>; openFile(id: string): Promise<void>; revealFile(id: string): Promise<void>;
  openTextLink(url: string): Promise<void>;
  sendText(text: string): Promise<void>; copyText(id: string): Promise<void>; cleanMessages(): Promise<void>;
  saveCrop(id: string, region: CropRegion): Promise<string | null>;
  copyCrop(id: string, region: CropRegion): Promise<void>;
  deletePhotos(ids: string[]): Promise<boolean>;
  copyPairing(): Promise<void>; exportDiagnostics(): Promise<void>;
  state(): Promise<DesktopState>; chooseDirectory(): Promise<void>; refreshPairing(): Promise<void>;
  selectAddress(address: string): Promise<void>; revoke(): Promise<void>; openDirectory(): Promise<void>;
  revealPhoto(id: string): Promise<void>; onChange(callback: () => void): () => void;
}
