// Upgrade NOTE: replaced '_Projector' with 'unity_Projector'
// Upgrade NOTE: replaced '_ProjectorClip' with 'unity_ProjectorClip'

// Projected light / shadow shapes (Unity Projector). Shapes are drawn in the shader, so no textures are needed.
// Blend mode is set from script: add (light), multiply (shadow / tint), alpha (paint).
Shader "Hidden/KeyframeStudio/Projector"
{
    Properties
    {
        _KfColor ("Colour", Color) = (1, 1, 1, 1)
        _KfShape ("Shape", Float) = 0
        _KfSoft ("Softness", Float) = 0.3
        _KfFalloff ("Distance falloff", Float) = 0.5
        _KfCount ("Count", Float) = 6
        _KfSpin ("Rotation", Float) = 0
        _KfMul ("Multiply mode", Float) = 0
        _SrcBlend ("", Float) = 1
        _DstBlend ("", Float) = 1
    }
    SubShader
    {
        Tags { "Queue" = "Transparent" }
        Pass
        {
            ZWrite Off
            ColorMask RGB
            Blend [_SrcBlend] [_DstBlend]
            Offset -1, -1

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            float4x4 unity_Projector;
            float4x4 unity_ProjectorClip;
            float4 _KfColor;
            float _KfShape, _KfSoft, _KfFalloff, _KfCount, _KfSpin, _KfMul;
            float4 _KfProjDir; // the projector's forward, world space (set from script)
            float _KfDebug;    // 0 off; 1 solid; 2 uv; 3 distance; 4 facing

            struct v2f
            {
                float4 uvShadow : TEXCOORD0;
                float4 uvFalloff : TEXCOORD1;
                float3 normalDot : TEXCOORD2;
                float4 pos : SV_POSITION;
            };

            v2f vert(float4 vertex : POSITION, float3 normal : NORMAL)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(vertex);
                o.uvShadow = mul(unity_Projector, vertex);
                o.uvFalloff = mul(unity_ProjectorClip, vertex);
                // facing the projector (no light on the back side)
                float3 n = UnityObjectToWorldNormal(normal);
                o.normalDot = float3(dot(n, -_KfProjDir.xyz), 0, 0);
                return o;
            }

            float Hash(float2 p) { return frac(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
            float Noise(float2 p)
            {
                float2 i = floor(p), f = frac(p);
                f = f * f * (3 - 2 * f);
                return lerp(lerp(Hash(i), Hash(i + float2(1, 0)), f.x), lerp(Hash(i + float2(0, 1)), Hash(i + 1), f.x), f.y);
            }

            // signed distance of each shape around the centre (p in -1..1), negative inside
            float Shape(float2 p)
            {
                int s = (int)round(_KfShape);
                float r = length(p);
                if (s == 0) return r - 0.85;                                  // soft circle
                if (s == 1) return abs(r - 0.6) - 0.18;                       // ring
                if (s == 2)                                                    // heart
                {
                    float2 q = p * 1.15;
                    q.y = -q.y + 0.25;
                    q.x = abs(q.x);
                    float a = q.x * q.x + q.y * q.y - 0.35;
                    return (a * a * a - q.x * q.x * q.y * q.y * q.y) * 3;
                }
                if (s == 3)                                                    // star
                {
                    float n = max(3, _KfCount);
                    float ang = atan2(p.y, p.x);
                    float k = cos(ang * n) * 0.5 + 0.5;
                    return r - lerp(0.38, 0.85, pow(k, 3));
                }
                if (s == 4)                                                    // blinds
                {
                    float n = max(2, _KfCount);
                    float band = abs(frac(p.y * n * 0.5) - 0.5) * 2;          // 0 in the gap … 1 on the slat
                    return max(band - 0.55, r - 1.0);
                }
                if (s == 5)                                                    // window panes
                {
                    float n = max(1, round(_KfCount / 3));
                    float2 g = abs(frac((p * 0.5 + 0.5) * (n + 1)) - 0.5);
                    float frame = 0.5 - max(g.x, g.y);                        // small near the frame bars
                    return max(0.06 - frame, max(abs(p.x), abs(p.y)) - 0.9);
                }
                if (s == 6)                                                    // leaf dapple
                {
                    float n = Noise(p * (2 + _KfCount * 0.5)) * 0.65 + Noise(p * (5 + _KfCount)) * 0.35;
                    return max(0.52 - n, r - 1.0);
                }
                return r - 0.85;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                if (_KfDebug > 0.5)
                {
                    if (_KfDebug < 1.5) return fixed4(1, 0, 0, 1);
                    if (_KfDebug < 2.5) return fixed4(frac(i.uvShadow.xy / i.uvShadow.w), i.uvShadow.w > 0 ? 1 : 0, 1);
                    if (_KfDebug < 3.5) return fixed4(saturate(i.uvFalloff.x), saturate(-i.uvFalloff.x), saturate(i.uvFalloff.w), 1);
                    return fixed4(saturate(i.normalDot.x), saturate(-i.normalDot.x), 0, 1);
                }
                float2 uv = i.uvShadow.xy / i.uvShadow.w;
                if (i.uvFalloff.x < 0 || i.uvFalloff.x > 1 || any(uv < 0) || any(uv > 1)) return _KfMul > 0.5 ? fixed4(1, 1, 1, 0) : fixed4(0, 0, 0, 0);
                float2 p = uv * 2 - 1;
                float c = cos(_KfSpin), s = sin(_KfSpin);
                p = float2(c * p.x - s * p.y, s * p.x + c * p.y);

                float soft = max(0.005, _KfSoft * 0.5);
                float mask = 1 - smoothstep(-soft, soft, Shape(p));
                float dist = saturate(i.uvFalloff.x);
                mask *= lerp(1, 1 - dist, saturate(_KfFalloff));
                mask *= saturate(i.normalDot.x * 4 + 0.25);
                float a = mask * _KfColor.a;

                if (_KfMul > 0.5) return fixed4(lerp(float3(1, 1, 1), _KfColor.rgb, a), 1); // shadow / tint
                return fixed4(_KfColor.rgb * a, a);
            }
            ENDCG
        }
    }
    Fallback Off
}
