import { LRUCache } from 'lru-cache';
import type { CacheEntry, CacheKey, CacheOptions, EncodedCacheStore, InspectableStore, StoreInspectOptions, StoreInspection, KeyInspection } from '../types/index.js';
import { matchesPattern } from './pattern.js';
import { deserialize, estimateValueBytes, inspectBuffer, serializeWithStats, sizeSavings } from '../utils/serializer.js';
import { DEFAULT_CACHE_TTL_MS, DEFAULT_L1_MAX_ENTRIES } from './defaults.js';
import { getDefaultMemoryBudget, MemoryBudget } from './memoryBudget.js';
const METADATA_BYTES = 160, HISTORY_BYTES = 4096, INSPECT_LIMIT = 100, VALUE_CAP = 256 * 1024;
type Stored = CacheEntry<Buffer> & { accounted: number; rawBytes?: number };
export interface MemoryStoreStats { retainedBytes: number; admitted: number; rejected: number; budget: ReturnType<MemoryBudget['snapshot']> }
export class MemoryStore<K extends CacheKey, V> implements EncodedCacheStore<K,V>, InspectableStore {
  readonly encodedFormat = 'lazy-layers-hc1' as const;
  private readonly cache: LRUCache<K, Stored>; private readonly budget: MemoryBudget; private readonly unregister:()=>void; private readonly sketch=new Uint8Array(4096); private readonly maxEntryBytes:number; private readonly admission:boolean; private readonly autoEvict:boolean; private admitted=0; private rejected=0; private closed=false;
  constructor(private readonly options: CacheOptions = {}) {
    const level=options.levels?.L1; this.budget=(options as CacheOptions & {memoryBudget?:MemoryBudget}).memoryBudget??getDefaultMemoryBudget(); this.maxEntryBytes=level?.admission?.maxEntryBytes??Math.min(16*1024*1024,Math.floor(this.budget.hardCap*.25)); this.admission=level?.admission?.enabled!==false; this.autoEvict=level?.autoEvict?.enabled!==false;
    this.cache=new LRUCache<K,Stored>({max:level?.maxEntries??DEFAULT_L1_MAX_ENTRIES,ttl:this.ttl(options),dispose:(e,k)=>this.disposeEntry(e,k)}); this.budget.tryReserve(HISTORY_BYTES,'metadata'); this.unregister=this.budget.register(()=>this.evictOne());
  }
  private ttl(o:CacheOptions):number { const t=o.levels?.L1?.ttlMs??o.ttlMs??this.options.levels?.L1?.ttlMs??this.options.ttlMs??DEFAULT_CACHE_TTL_MS; if(!Number.isFinite(t)||t<=0)throw new RangeError('ttlMs must be positive and finite'); return t; }
  private byteSize(k:K,b:Uint8Array){return b.byteLength+Buffer.byteLength(String(k),'utf8')*2+METADATA_BYTES}
  private hash(k:K){let h=2166136261;for(const c of String(k))h=Math.imul(h^c.charCodeAt(0),16777619);return(h>>>0)%4096}
  private touch(k:K){const i=this.hash(k);return this.sketch[i]=Math.min(255,this.sketch[i]+1)}
  private disposeEntry(e:Stored,k:K){this.budget.release(e.accounted,'fresh')}
  private evictOne(){const k=this.cache.keys().next().value as K|undefined;return k===undefined?false:this.cache.delete(k)}
  private async put(k:K,b:Uint8Array,o:CacheOptions,rawBytes?:number){if(this.closed)return;const owned=Buffer.allocUnsafeSlow(b.byteLength);Buffer.from(b).copy(owned);const bytes=this.byteSize(k,owned);if(bytes>this.maxEntryBytes){this.rejected++;return}this.touch(k);if(this.cache.has(k))this.cache.delete(k);if(this.autoEvict)for(let n=0;n<16&&!this.budget.permitsPromotion(bytes)&&this.evictOne();n++);if(!this.budget.tryReserve(bytes,'fresh')){this.rejected++;return}this.cache.set(k,{value:owned,accounted:bytes,rawBytes},{ttl:this.ttl(o)});this.admitted++}
  async set(k:K,v:V,o:CacheOptions={}):Promise<void>{try{const s=serializeWithStats(v);await this.put(k,s.buffer,o,s.originalBytes)}catch{} }
  async setEncoded(k:K,b:Uint8Array,o:CacheOptions={},originalBytes?:number){await this.put(k,b,o,originalBytes)}
  async get(k:K){const e=this.cache.get(k);return e?deserialize(e.value) as V:undefined}
  async getEncoded(k:K){const e=this.cache.get(k);return e?{buffer:Buffer.from(e.value),ttlRemainingMs:this.cache.getRemainingTTL(k),originalBytes:e.rawBytes}:undefined}
  async getOrSet(k:K,l:()=>Promise<V|undefined>,o?:CacheOptions){const v=await this.get(k);if(v!==undefined||await this.has(k))return v;const x=await l();if(x!==undefined)await this.set(k,x,o);return x}
  async has(k:K){return this.cache.has(k)} async delete(k:K){this.cache.delete(k)}
  async deleteByPattern(p:string){for(const k of this.cache.keys())if(matchesPattern(String(k),p))this.cache.delete(k)} async clear(){this.cache.clear()} async size(){return this.cache.size}
  stats():MemoryStoreStats{return{retainedBytes:this.budget.snapshot().accountedBytes,admitted:this.admitted,rejected:this.rejected,budget:this.budget.snapshot()}}
  async inspect(o:StoreInspectOptions={}):Promise<StoreInspection>{const lim=o.limit&&o.limit>0?o.limit:INSPECT_LIMIT,off=Number.parseInt(o.cursor??'0',10)||0,inc=o.includeValues!==false,cap=o.maxValueBytes??VALUE_CAP,keys:KeyInspection[]=[];let i=0;for(const k of this.cache.keys()){if(o.match&&!matchesPattern(String(k),o.match))continue;if(i++<off)continue;if(keys.length>=lim)break;const e=this.cache.peek(k);if(!e)continue;const d=inc&&e.rawBytes!==undefined?inspectBuffer(e.value):undefined,s=e.value.byteLength,r=d?estimateValueBytes(d.value):(e.rawBytes??0),x:KeyInspection={key:String(k),ttlRemainingMs:this.cache.getRemainingTTL(k),serializedBytes:s,deserializedBytes:r,compressionRatio:sizeSavings(s,r),encoding:d?.encoding??'legacy'};if(inc&&d&&r<=cap)x.value=d.value;else if(inc)x.truncated=true;keys.push(x)}return{size:this.cache.size,cursor:keys.length===lim?String(off+keys.length):undefined,keys}}
  close(){if(this.closed)return;this.closed=true;this.cache.clear();this.budget.release(HISTORY_BYTES,'metadata');this.unregister()}
}
