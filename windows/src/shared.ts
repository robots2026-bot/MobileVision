export interface Photo { id: string; photoId: string; deviceName: string; receivedAt: string; capturedAt: string; bytes: number; width: number; height: number; filename: string; }
export interface DesktopState {
  directory: string; addresses: string[]; selectedAddress: string; port: number; running: boolean;
  pairing: { qr: string; expiresAt: number }; device: { name: string; lastSeen: number } | null;
  photos: Photo[]; error: string | null;
}
export interface CropRegion { x: number; y: number; width: number; height: number; }
export interface DesktopAPI {
  saveCrop(id: string, region: CropRegion): Promise<string | null>;
  copyCrop(id: string, region: CropRegion): Promise<void>;
  deletePhotos(ids: string[]): Promise<boolean>;
  copyPairing(): Promise<void>; exportDiagnostics(): Promise<void>;
  state(): Promise<DesktopState>; chooseDirectory(): Promise<void>; refreshPairing(): Promise<void>;
  selectAddress(address: string): Promise<void>; revoke(): Promise<void>; openDirectory(): Promise<void>;
  revealPhoto(id: string): Promise<void>; onChange(callback: () => void): () => void;
  showFloat(): Promise<void>; showMain(): Promise<void>; floatMenu(): Promise<void>;
}
