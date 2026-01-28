export class LRUCache<T> {
	private cache = new Map<string, T>();

	constructor(private readonly maxSize: number = 5000) {}

	get(key: string): T | undefined {
		if (!this.cache.has(key)) {
			return undefined;
		}
		const value = this.cache.get(key);
		if (value !== undefined) {
			this.cache.delete(key);
			this.cache.set(key, value);
		}
		return value;
	}

	put(key: string, value: T): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}
		this.cache.set(key, value);
		if (this.cache.size > this.maxSize) {
			const lruKey = this.cache.keys().next().value as string | undefined;
			if (lruKey !== undefined) {
				this.cache.delete(lruKey);
			}
		}
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}
